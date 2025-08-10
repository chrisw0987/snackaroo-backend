const path = require("path");
require('dotenv').config({
  path: path.resolve(__dirname, '.env'),
  override: true,   
  debug: true       
});
console.log('Loaded STRIPE_SECRET_KEY prefix:', (process.env.STRIPE_SECRET_KEY || 'MISSING').slice(0, 7));

const PORT = process.env.PORT || 4000;
const express = require("express");
const app = express();
app.set('trust proxy', 1); 
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const multer = require("multer");
const cors = require("cors");
const Stripe = require('stripe');
const { get } = require("http");
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const getBaseUrl = (req) => {
    const proto = req.get('x-forwarded-proto') || req.protocol || 'https';
    const host = req.get('host');
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

      // When payment succeeds
      if (event.type === 'payment_intent.succeeded') {
        const paymentIntent = event.data.object;
        const userId = paymentIntent.metadata.userId;
        const shippingDetails = JSON.parse(paymentIntent.metadata.shippingDetails || "{}");


        // Fetch user data & cart
        const userData = await Users.findOne({ _id: userId });
        const cart = userData.cartData;

        // Save order
        const order = new Orders({
          userId,
          items: cart,
          totalAmount: paymentIntent.amount / 100,
          status: 'Paid',
          shippingDetails,
        });

        await order.save();

        // Clear cart
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

const allowedOrigins = [
  'https://chrisw0987.github.io',               
  'https://chrisw0987.github.io/snackaroo-admin', 
  'https://chrisw0987.github.io/snackaroo-frontend',
];

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true);

    if (allowedOrigins.some(o => origin.startsWith(o))) return cb(null, true);

    cb(new Error('Not allowed by CORS: ' + origin));
  },
  methods: ['GET','POST','PUT','DELETE','OPTIONS'],
  allowedHeaders: ['Content-Type', 'auth-token', 'stripe-signature'],
}));

app.options('*', cors());


//DB Connect 
mongoose.connect(process.env.MONGO_URI);

//API 
app.get('/', (req,res)=> {
    res.send("Express App is Running");
});

//Image Storage
const storage = multer.diskStorage({
    destination: './upload/images',
    filename: (req,file,cb) => {
        return cb(null, `${file.fieldname}_${Date.now()}${path.extname(file.originalname)}`)
    }
});


const upload = multer({storage:storage});
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

//Create Upload Endpoint for IMG
app.use('/images', express.static('upload/images'));

function getBaseUrl(req) {
    const explicit = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL;
    if (explicit) return explicit;
    const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').split(',')[0];
    const host = (req.headers['x-forwarded-host'] || req.get('host'));
    return `${proto}://${host}`;
}


app.post('/upload', upload.single('product'), (req,res)=>{
    const baseUrl = getBaseUrl(req);
    const relPath = `/images/${req.file.filename}`;
    const absolute = `${baseUrl}${relPath}`;

    res.json({
        success: 1,
        image_path: relPath,
        image_url: absolute,
    });
});

//Schema for Creating Products
const Product = mongoose.model("Product", {
    id: {
        type: Number,
        required: true,
    },
    name: {
        type: String,
        required: true,
    },
    image: {
        type: String,
        required: true,
    },
    category: {
        type:String,
        required: true,
    },
    new_price: {
        type: Number,
        required: true,
    },
    old_price: {
        type: Number,
        required: true,
    },
    date: {
        type: Date,
        default: Date.now,
    },
    available: {
        type: Boolean,
        default: true
    },
});

//CREATE API FOR ADDING PRODUCT
app.post('/addproduct', async (req,res)=> {
    let products = await Product.find({});
    let id;
    if (products.length>0) {
        let last_product_array = products.slice(-1);
        let last_product = last_product_array[0];
        id = last_product.id + 1;
    }
    else {
        id = 1;
    }
    const imageValue = req.body.image_path || req.body.image;
     const product = new Product({
        id: id,
        name: req.body.name,
        image: imageValue,
        category: req.body.category,
        new_price: req.body.new_price,
        old_price: req.body.old_price,
     });
     console.log(product);
     await product.save();
     console.log(`Saved`);
     res.json({
        success: true,
        name: req.body.name,
     });
});

//CREATE API FOR DELETE PRODUCT
app.post('/removeproduct', async(req,res)=> {
    await Product.findOneAndDelete({id:req.body.id});
    console.log(`Removed`);
    res.json({
        success: true,
        name: req.body.name,
    })
});

//CREATE API FOR GETTING ALL PRODUCTS
app.get('/allproducts', async (req,res)=> {
    let products = await Product.find({});
    console.log("All Products Fetched");
    res.send(products);
});

//Schema for User Model
const Users = mongoose.model('Users', {
    name: {
        type: String,
    },
    email: {
        type: String,
        unique: true,
    },
    password: {
        type: String,
    },
    cartData: {
        type: Object,
    },
    date: {
        type: Date,
        default: Date.now,
    }
});


//Create Endpoint for Register User
app.post('/signup', async (req,res)=> {
    let check = await Users.findOne({email: req.body.email});
    if (check) {
        return res.status(400).json({success: false, error: 'Existing User Found With Email/Password'});
    }
    let cart = {};
    for (let i = 0;i < 300; i++) {
        cart[i] = 0;
    }
    const user = new Users({
        name: req.body.username,
        email: req.body.email,
        password: req.body.password,
        cartData: cart,
    });

    await user.save();

    const data = {
        user: {
            id: user.id
        }
    }
    const token = jwt.sign(data, process.env.JWT_SECRET);
    res.json({success:true, token});
});


//Endpoint for User Login
app.post('/login', async (req,res)=> {
    let user = await Users.findOne({email:req.body.email});
    if (user) {
        const passwordCompare = req.body.password === user.password;
        if (passwordCompare) {
            const data = {
                user: {
                    id: user.id,
                }
            }
            const token = jwt.sign(data,'secret_ecom');
            res.json({success: true, token});
        }
        else {
            res.json({success: false, errors: "Wrong Password"});
        }
    }
    else {
        res.json({success: false, errors: "Wrong Email"});
    }
});

//Create Endpoint For New Collection Data
app.get('/newcollections', async (req,res)=> {
    let products = await Product.find({});
    let newcollections = products.slice(1).slice(-8);
    console.log("New Collection Fetched");
    res.send(newcollections);
})

//Create Endpoint For Popular Snacks
app.get('/popularsnacks', async (req,res)=> {
    let products = await Product.find({category:"sweets"});
    let popular_snacks = products.slice(0,4);
    console.log("Popular Snacks Fetched");
    res.send(popular_snacks);
})

//Create Middleware to Fetch User Cart Data
const fetchUser = async (req,res,next)=> {
    const token = req.header('auth-token');
    if (!token) {
        res.status(401).send({errors: "Please Authenticate Using Valid Token"});
    }
    else {
        try {
            const data = jwt.verify(token, process.env.JWT_SECRET);
            req.user = data.user;
            next();
        } catch (error) {
            res.status(401).send({errors: "Please Authenticate Using Valid Token"});
        }
    }
}

//Create Endpoint For Adding Products in Cart Data
app.post('/addtocart', fetchUser, async (req,res)=> {
    const {itemId, quantity} = req.body;
    console.log("Added: ", req.body.itemId, "Quantity: ", req.body.quantity);
    let userData = await Users.findOne({_id:req.user.id});

    if (!userData.cartData[itemId]) {
        userData.cartData[itemId] = 0;
    }
    
    userData.cartData[req.body.itemId] += quantity || 1;
    await Users.updateOne({ _id: req.user.id },{ $set: {[`cartData.${itemId}`]: userData.cartData[itemId]}});
    res.send('Added');
})

//Creating Endpoint to Remove Product From Cart Data
app.post('/removecart', fetchUser, async (req,res)=> {
    console.log("Removed", req.body.itemId);
    let userData = await Users.findOne({_id:req.user.id});
    if (userData.cartData[req.body.itemId] > 0) {
        userData.cartData[req.body.itemId] -= 1;
        await Users.updateOne({_id:req.user.id},{$set:{cartData:userData.cartData}});
        res.send('Removed');
    }
});

//Creating Endpoint to Get Cart Data
app.post('/getcart', fetchUser, async (req,res)=> {
    console.log("GetCart");
    let userData = await Users.findOne({_id:req.user.id});
    res.json(userData.cartData);
})


//Schema For Orders Model
const Orders = mongoose.model('Orders', {
    userId: {
        type: String,
    },
    items: {
        type: Object,
    },
    totalAmount: {
        type: Number,
    },
    shippingDetails: {
        type: Object, 
        default: {},
    },
    date: { 
        type: Date, 
        default: Date.now 
    },
    status: { 
        type: String, 
        default: "Pending" 
    },
    shippingDetails: {
        first_name: String,
        last_name: String,
        address: String,
        city: String,
        state: String,
        zipcode: String,
        phone_number: String,
  },
})

//Create Endpoint for Checkout
app.post('/checkout', fetchUser, async (req,res)=> {
    try {
        const { shippingDetails } = req.body;
        const userData = await Users.findOne({_id: req.user.id});
        const cart = userData.cartData;
        let totalAmount = 0;
    
        for (const itemId in cart) {
            if (cart[itemId] > 0) {
                const product = await Product.findOne({id: itemId});
            if (product) {
                totalAmount += product.new_price * cart[itemId];
            }
        }
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(totalAmount * 100),
      currency: 'usd',
      metadata: { 
        userId: req.user.id,
        shippingDetails: JSON.stringify(shippingDetails), 
    },
    });

    res.json({ clientSecret: paymentIntent.client_secret });
} catch (error) {
    res.status(500).json({ success: false, errors: error.message });
  }
});


app.listen(PORT, (error)=> {
    if (!error) {
        console.log(`Server Runnin on Port ${PORT}`); 
    }
    else {
        console.log(`Error ` + error);
    }
});