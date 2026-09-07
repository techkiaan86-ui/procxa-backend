// Polyfill for SlowBuffer which is removed in newer Node.js versions (v25+)
// This must happen before any other requires
const buffer = require('buffer');
if (!buffer.SlowBuffer) {
  buffer.SlowBuffer = function (size) {
    return buffer.Buffer.allocUnsafeSlow(size);
  };
  buffer.SlowBuffer.prototype = buffer.Buffer.prototype;
}
if (typeof global.SlowBuffer === 'undefined') {
  global.SlowBuffer = buffer.SlowBuffer;
}
console.log('✅ SlowBuffer polyfill applied for Node.js 25 compatibility');

require('dotenv').config()
const express = require('express');
const bodyParser = require('body-parser');
const cookieParser = require('cookie-parser');
const cors = require("cors");
const path = require('path');
require('./src/cronJob/cronJob');

const app = express()

// ============================================
// CORS CONFIGURATION - MUST BE BEFORE ROUTES
// ============================================

// Define allowed origins (both local and production frontend URLs)
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
  'http://localhost:5176',
  'http://localhost:5177',
  'http://localhost:5178',
  'http://localhost:3000',
  'https://proxa-ai-backend-production-9800.up.railway.app',
  'https://procxa.kiaansoftware.com',
  process.env.FRONTEND_URL,
  process.env.CLIENT_URL,
].filter(Boolean);

// CORS options configuration
const corsOptions = {
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps, Postman, or same-origin requests)
    if (!origin) {
      return callback(null, true);
    }

    // Allow any localhost / 127.0.0.1 port in development or if listed
    const isLocalhost = /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (isLocalhost || allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }

    // Strict in production for unrecognized external domains
    console.log(`[CORS] Blocked origin: ${origin}`);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: [
    'Content-Type',
    'Authorization',
    'X-Refresh-Token',
    'X-Requested-With',
    'Accept',
    'Origin'
  ],
  exposedHeaders: ['Authorization', 'X-Refresh-Token'],
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 200
};

// Apply CORS middleware globally BEFORE routes
app.use(cors(corsOptions));

// Explicitly handle OPTIONS requests for all routes (preflight)
app.options('*', cors(corsOptions));

// ============================================
// MIDDLEWARE SETUP
// ============================================

// JSON body parser with proper error handling
// Allow empty bodies for routes that don't need request body (like toggle-admin)
app.use(bodyParser.json({
  limit: '10mb',
  strict: false // Allow empty bodies and non-array/object JSON
}));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.use(express.static(path.join(__dirname, "public")));
app.use(cookieParser());

// ============================================
// ROUTES
// ============================================

const mainRoutes = require("./src/routes/main.routes")
app.use("/procxa", mainRoutes)

// ============================================
// ERROR HANDLING MIDDLEWARE
// ============================================

// Error handling middleware for JSON parsing errors (must be after routes)
app.use((err, req, res, next) => {
  // CORS error handling
  if (err.message === 'Not allowed by CORS') {
    return res.status(403).json({
      status: false,
      message: 'CORS: Origin not allowed',
      origin: req.headers.origin
    });
  }

  // JSON parsing errors - handle gracefully for empty bodies
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    // For routes that don't require body (like PUT toggle-admin), allow empty body
    const method = req.method;
    const path = req.path;

    // Allow empty body for toggle-admin route
    if (method === 'PUT' && path.includes('toggle-admin')) {
      // Set empty body and continue
      req.body = {};
      return next();
    }

    // For other routes, return error
    return res.status(400).json({
      status: false,
      message: 'Invalid JSON format in request body'
    });
  }

  // Generic error handler
  console.error('Error:', err);
  res.status(err.status || 500).json({
    status: false,
    message: err.message || 'Internal server error'
  });
});

// ============================================
// SERVER STARTUP
// ============================================

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send(`Hello procxa web services, Server is running on port : ${PORT}`)
})

app.listen(PORT, () => {
  console.log(`Server is running for procxa at port ${PORT} `);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`Database Host: ${process.env.DB_HOST || 'not set'}`);
  console.log(`[CORS] Allowed origins: ${allowedOrigins.join(', ')}`);
  console.log(`[CORS] Credentials: enabled`);
})
