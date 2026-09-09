const path = require('node:path');
require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const nodemailer = require('nodemailer');
const multer = require('multer');

const app = express();
const port = process.env.PORT || 4242;
const stripeKey = process.env.STRIPE_SECRET_KEY;
const stripe = stripeKey ? new Stripe(stripeKey) : null;
const contactEmail = process.env.CONTACT_EMAIL || 'zakode03@gmail.com';
const mailer = process.env.SMTP_USER && process.env.SMTP_PASS
  ? nodemailer.createTransport({
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: process.env.SMTP_SECURE !== 'false',
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })
  : null;
const upload = multer({ limits: { files: 5, fileSize: 8 * 1024 * 1024 } });
const catalog = {
  'Support de manette': { price: 24, image: 'support_manette2.png' },
  'Support DJI Neo 2': { price: 29, image: 'support_neo2.png' },
  'Batarang mural': { price: 18.7, image: 'batarang.png' },
  'Dragon articulé': { price: 19, image: 'dragon_articulé.png' },
  'Loutre articulée': { price: 19, image: 'loutre_articulé.png' },
};
const promotions = { MY3D10: 0.10 };

app.use(express.json());
app.use(express.static(__dirname));

app.post('/send-project-request', upload.array('reference', 5), async (req, res) => {
  if (!mailer) {
    return res.status(503).json({ error: 'Email SMTP is not configured.' });
  }

  const { name, email, phone, type, budget, dimensions, message } = req.body;
  if (!name || !email || !phone || !message) {
    return res.status(400).json({ error: 'Les champs obligatoires sont incomplets.' });
  }

  try {
    await mailer.sendMail({
      from: `My3DPrint <${process.env.SMTP_USER}>`,
      to: contactEmail,
      replyTo: email,
      subject: `Nouvelle demande sur mesure - ${name}`,
      text: [
        `Prénom : ${name}`,
        `Email : ${email}`,
        `Téléphone : ${phone}`,
        `Type : ${type || 'Non précisé'}`,
        `Budget : ${budget || 'Non précisé'}`,
        `Dimensions : ${dimensions || 'Non précisées'}`,
        '',
        'Projet :',
        message,
      ].join('\n'),
      attachments: (req.files || []).map((file) => ({ filename: file.originalname, content: file.buffer, contentType: file.mimetype })),
    });
    res.json({ success: true });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Impossible d’envoyer la demande.' });
  }
});

app.post('/create-checkout-session', async (req, res) => {
  if (!stripe) {
    return res.status(503).json({ error: 'STRIPE_SECRET_KEY is not configured.' });
  }

  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const promoCode = String(req.body.promoCode || '').trim().toUpperCase();
  if (!items.length) {
    return res.status(400).json({ error: 'Cart is empty.' });
  }

  try {
    const lineItems = items.map((item) => {
      const product = catalog[item.name];
      if (!product) throw new Error(`Unknown product: ${item.name}`);
      return {
      quantity: Math.min(20, Math.max(1, Number(item.quantity) || 1)),
      price_data: {
        currency: 'eur',
        product_data: {
          name: item.name,
          description: item.color ? `Couleur : ${String(item.color).slice(0, 50)}` : undefined,
        },
        unit_amount: Math.round(product.price * 100),
      },
      };
    });

    const subtotal = items.reduce((sum, item) => sum + catalog[item.name].price * Math.min(20, Math.max(1, Number(item.quantity) || 1)), 0);
    const discountRate = promotions[promoCode] || 0;
    const discountedSubtotal = Math.round(subtotal * (1 - discountRate) * 100) / 100;
    const shippingOptions = discountedSubtotal >= 60
      ? [{ shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: 0, currency: 'eur' }, display_name: 'Livraison offerte' } }]
      : [{ shipping_rate_data: { type: 'fixed_amount', fixed_amount: { amount: 490, currency: 'eur' }, display_name: 'Livraison suivie' } }];

    const discounts = discountRate
      ? [{ coupon: (await stripe.coupons.create({ percent_off: discountRate * 100, duration: 'once', name: `My3DPrint ${promoCode}` })).id }]
      : undefined;
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items: lineItems,
      shipping_address_collection: { allowed_countries: ['FR', 'BE', 'LU', 'DE', 'ES', 'IT', 'NL', 'PT', 'CH'] },
      shipping_options: shippingOptions,
      discounts,
      customer_creation: 'always',
      success_url: `${req.protocol}://${req.get('host')}/?payment=success`,
      cancel_url: `${req.protocol}://${req.get('host')}/?payment=cancelled`,
    });

    res.json({ url: session.url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: 'Unable to create Stripe Checkout session.' });
  }
});

app.use((error, req, res, next) => {
  if (error) {
    console.error(error);
    return res.status(400).json({ error: 'La pièce jointe est invalide ou trop volumineuse.' });
  }
  next();
});

app.listen(port, () => {
  console.log(`My3DPrint is running at http://localhost:${port}`);
});
