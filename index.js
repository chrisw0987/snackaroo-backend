const path = require('path');
require('dotenv').config({
  path: path.resolve(__dirname, '.env'),
  override: true,
});

const PORT = process.env.PORT || 4000;
const express = require('express');
const app = express();
const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const cors = require('cors');
const Stripe = require('stripe');
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

function getBaseUrl(req) {
  const explicit = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
  if (explicit) return explicit; 

  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString().split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

app.post(
  '/webhook',
  express.raw({ type: 'application/json' }),
  async (req, res) => {
    const sig = req.headers['stripe-signature'];
    try {
      const event = stripe.webhooks.constructEvent(
        req.body,
        sig,
        process.env.STRIPE_WEBHOOK_SECRET
      );

      if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const userId = paymentIntent.metadata.userId;
        const shippingDetails = JSON.parse(paymentIntent.metadata.shippingDetails || '{}');

        const userData = await Users.findOne({ _id: userId });
        const cart = userData?.cartData || {};

        const order = new Orders({
          userId,
          items: cart,
          totalAmount: paymentIntent.amount / 100,
          status: 'Paid',
          shippingDetails,
        });

        await order.save();

        await Users.updateOne({ _id: userId }, { cartData: {} });
      }

      res.json({ received: true });
    } catch (err) {
      console.error('Webhook error:', err.message);
      res.status(400).send(`Webhook Error: ${err.message}`);
    }
  }
);


app.use(express.json());

app.use(
  cors({
    origin: [
      'https://chrisw0987.github.io',                
      'https://chrisw0987.github.io/snackaroo-admin', 
      'https://chrisw0987.github.io/snackaroo-frontend', 
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'auth-token', 'stripe-signature'],
  })
);

mongoose.connect(process.env.MONGO_URI);


app.get('/', (req, res) => {
  res.send('Express App is Running');
});

const storage = multer.diskStorage({
  destination: './upload/images',
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/\s+/g, '_');
    cb(null, `product_${Date.now()}_${safe}`);
  },
});
const upload = multer({ storage });

app.use('/images', express.static('upload/images'));

// Upload endpoint returns relative + absolute URL
app.post('/upload', upload.single('product'), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ success: 0, error: 'No file uploaded' });
  }
  const baseUrl = getBaseUrl(req);
  const relPath = `/images/${req.file.filename}`;
  res.json({
    success: 1,
    image_path: relPath,             
    image_url: `${baseUrl}${relPath}` 
  });
});

const Product = mongoose.model('Product', {
  id: { type: Number, required: true },
  name: { type: String, required: true },
  image: { type: String, required: true }, 
  category: { type: String, required: true },
  new_price: { type: Number, required: true },
  old_price: { type: Number, required: true },
  date: { type: Date, default: Date.now },
  available: { type: Boolean, default: true },
});

const Users = mongoose.model('Users', {
  name: { type: String },
  email: { type: String, unique: true },
  password: { type: String },
  cartData: { type: Object },
  date: { type: Date, default: Date.now },
});

const Orders = mongoose.model('Orders', {
  userId: { type: String },
  items: { type: Object },
  totalAmount: { type: Number },
  status: { type: String, default: 'Pending' },
  shippingDetails: {
    first_name: String,
    last_name: String,
    address: String,
    city: String,
    state: String,
    zipcode: String,
    phone_number: String,
  },
  date: { type: Date, default: Date.now },
});


app.post('/addproduct', async (req, res) => {
  try {
    
    const last = await Product.findOne({}).sort({ id: -1 }).lean();
    const id = last ? last.id + 1 : 1;

    const raw = req.body.image_path || req.body.image || '';
    const imageAbs = raw.startsWith('http') ? raw : `${getBaseUrl(req)}${raw}`;

    const product = new Product({
      id,
      name: req.body.name,
      image: imageAbs,
      category: req.body.category,
      new_price: req.body.new_price,
      old_price: req.body.old_price,
    });

    await product.save();
    res.json({ success: true, name: req.body.name });
  } catch (e) {
    console.error('addproduct error:', e);
    res.status(500).json({ success: false, error: 'Failed to add product' });
  }
});

app.post('/removeproduct', async (req, res) => {
  await Product.findOneAndDelete({ id: req.body.id });
  res.json({ success: true });
});

app.get('/allproducts', async (req, res) => {
  const products = await Product.find({});
  res.send(products);
});

app.post('/signup', async (req, res) => {
  const check = await Users.findOne({ email: req.body.email });
  if (check) {
    return res.status(400).json({ success: false, error: 'Existing User Found With Email/Password' });
  }
  const cart = {};
  for (let i = 0; i < 300; i++) cart[i] = 0;

  const user = new Users({
    name: req.body.username,
    email: req.body.email,
    password: req.body.password,
    cartData: cart,
  });

  await user.save();

  const data = { user: { id: user.id } };
  const token = jwt.sign(data, process.env.JWT_SECRET);
  res.json({ success: true, token });
});

app.post('/login', async (req, res) => {
  const user = await Users.findOne({ email: req.body.email });
  if (user) {
    const passwordCompare = req.body.password === user.password;
    if (passwordCompare) {
      const data = { user: { id: user.id } };
      const token = jwt.sign(data, process.env.JWT_SECRET);
      return res.json({ success: true, token });
    }
    return res.json({ success: false, errors: 'Wrong Password' });
  }
  res.json({ success: false, errors: 'Wrong Email' });
});

app.get('/newcollections', async (req, res) => {
  const products = await Product.find({});
  const newcollections = products.slice(1).slice(-8);
  res.send(newcollections);
});

app.get('/popularsnacks', async (req, res) => {
  const products = await Product.find({ category: 'sweets' });
  const popular_snacks = products.slice(0, 4);
  res.send(popular_snacks);
});

const fetchUser = async (req, res, next) => {
  const token = req.header('auth-token');
  if (!token) {
    return res.status(401).send({ errors: 'Please Authenticate Using Valid Token' });
  }
  try {
    const data = jwt.verify(token, process.env.JWT_SECRET);
    req.user = data.user;
    next();
  } catch (_err) {
    res.status(401).send({ errors: 'Please Authenticate Using Valid Token' });
  }
};

app.post('/addtocart', fetchUser, async (req, res) => {
  const { itemId, quantity } = req.body;
  const userData = await Users.findOne({ _id: req.user.id });
  if (!userData.cartData[itemId]) userData.cartData[itemId] = 0;
  userData.cartData[itemId] += quantity || 1;
  await Users.updateOne({ _id: req.user.id }, { $set: { [`cartData.${itemId}`]: userData.cartData[itemId] } });
  res.send('Added');
});

app.post('/removecart', fetchUser, async (req, res) => {
  const userData = await Users.findOne({ _id: req.user.id });
  if (userData.cartData[req.body.itemId] > 0) {
    userData.cartData[req.body.itemId] -= 1;
    await Users.updateOne({ _id: req.user.id }, { $set: { cartData: userData.cartData } });
  }
  res.send('Removed');
});

app.post('/getcart', fetchUser, async (req, res) => {
  const userData = await Users.findOne({ _id: req.user.id });
  res.json(userData.cartData);
});

app.post('/checkout', fetchUser, async (req, res) => {
  try {
    const { shippingDetails } = req.body;
    const userData = await Users.findOne({ _id: req.user.id });
    const cart = userData.cartData || {};
    let totalAmount = 0;

    for (const itemId in cart) {
      if (cart[itemId] > 0) {
        const product = await Product.findOne({ id: Number(itemId) });
        if (product) totalAmount += product.new_price * cart[itemId];
      }
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(totalAmount * 100), 
      currency: 'usd',
      metadata: {
        userId: req.user.id,
        shippingDetails: JSON.stringify(shippingDetails || {}),
      },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    console.error('checkout error:', error);
    res.status(500).json({ success: false, errors: error.message });
  }
});

app.listen(PORT, (error) => {
  if (!error) {
    console.log(`Server Running on Port ${PORT}`);
  } else {
    console.log('Error ' + error);
  }
});