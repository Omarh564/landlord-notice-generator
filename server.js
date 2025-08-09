// server.js
//
// Main entry point for the UK Landlord Legal Notice Generator.
// This Express server renders a simple front‑end using EJS templates and
// generates PDF notices based on user input. It also integrates with
// Stripe Checkout to collect payments. Replace the `STRIPE_SECRET_KEY`
// environment variable with your secret key from Stripe before running.

const path = require('path');
const fs = require('fs');
const express = require('express');
const bodyParser = require('body-parser');
const PDFDocument = require('pdfkit');

// Initialize Stripe with your secret key.  The key should be set in
// an environment variable named STRIPE_SECRET_KEY.  See README.md for
// instructions on how to set up your secret and publishable keys.
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || '';
let stripe;
if (stripeSecretKey) {
  stripe = require('stripe')(stripeSecretKey);
}

const app = express();

// Configure EJS as the template engine.
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Serve static assets from the public directory.
app.use('/static', express.static(path.join(__dirname, 'public')));

// Parse form submissions.
app.use(bodyParser.urlencoded({ extended: false }));

/**
 * Helper to build the data needed for each notice type.
 * @param {string} type – The notice type slug (e.g. 'section21').
 * @returns {Object} Metadata describing the document.
 */
function getNoticeConfig(type) {
  switch (type) {
    case 'section21':
      return {
        name: 'Section 21 (Form 6A) – Notice to End Assured Shorthold Tenancy',
        price: 1500, // Amount in pence (£15)
        description: 'Official Section 21 notice (Form 6A) to end an assured shorthold tenancy.'
      };
    case 'section8':
      return {
        name: 'Section 8 – Eviction Notice',
        price: 2000, // £20
        description: 'Section 8 notice for eviction due to rent arrears or breach of tenancy.'
      };
    case 'rentincrease':
      return {
        name: 'Rent Increase Letter',
        price: 1000, // £10
        description: 'Letter to formally notify tenants of a rent increase.'
      };
    case 'renewal':
      return {
        name: 'Tenancy Renewal Offer Letter',
        price: 1000, // £10
        description: 'Letter offering tenants a renewal of their tenancy agreement.'
      };
    default:
      return null;
  }
}

/**
 * Renders the home page.
 */
app.get('/', (req, res) => {
  res.render('home');
});

/**
 * Renders the notice selection page.
 */
app.get('/select', (req, res) => {
  res.render('select');
});

/**
 * Renders the data entry form for a specific notice type.
 */
app.get('/form/:type', (req, res) => {
  const { type } = req.params;
  const config = getNoticeConfig(type);
  if (!config) {
    return res.status(404).render('error', { message: 'Invalid notice type.' });
  }
  res.render('form', { type, config });
});

/**
 * Handles the POST request from the notice form.  Creates a Stripe
 * Checkout session and redirects the user to Stripe for payment.
 */
app.post('/create-session', async (req, res) => {
  const {
    type,
    landlordName,
    landlordAddress,
    tenantName,
    tenantAddress,
    propertyAddress,
    tenancyStart,
    noticeEnd,
    reason
  } = req.body;

  const config = getNoticeConfig(type);
  if (!config) {
    return res.status(400).render('error', { message: 'Invalid notice type.' });
  }

  // Compose metadata to store user input.  We'll serialise this to JSON.
  const metadata = {
    type,
    landlordName,
    landlordAddress,
    tenantName,
    tenantAddress,
    propertyAddress,
    tenancyStart,
    noticeEnd,
    reason: reason || ''
  };

  // Ensure Stripe is configured.
  if (!stripe) {
    return res.status(500).render('error', { message: 'Payment system is not configured. Please provide your STRIPE_SECRET_KEY in the environment.' });
  }

  try {
    // Create a new Stripe Checkout session.  When the user finishes
    // checkout, Stripe will redirect them back to /success with a
    // session_id parameter.
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: 'gbp',
            product_data: {
              name: config.name,
              description: config.description
            },
            unit_amount: config.price
          },
          quantity: 1
        }
      ],
      metadata: metadata,
      success_url: `${req.protocol}://${req.get('host')}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${req.protocol}://${req.get('host')}/error`
    });

    res.redirect(303, session.url);
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Failed to create payment session.' });
  }
});

/**
 * Success page.  After payment, Stripe redirects the user here with a
 * session_id query parameter.  We retrieve the session, parse the
 * metadata, and generate a PDF document with the user's information.
 */
app.get('/success', async (req, res) => {
  const { session_id } = req.query;
  if (!session_id) {
    return res.status(400).render('error', { message: 'Missing session ID.' });
  }
  if (!stripe) {
    return res.status(500).render('error', { message: 'Payment system is not configured.' });
  }
  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const metadata = session.metadata || {};
    // Generate PDF and save to a buffer
    const pdfBuffer = await generatePdf(metadata);
    // Set response headers to download the file
    const filename = `${metadata.type || 'notice'}-${Date.now()}.pdf`;
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename=\"${filename}\"`);
    res.send(pdfBuffer);
  } catch (err) {
    console.error(err);
    res.status(500).render('error', { message: 'Failed to retrieve session.' });
  }
});

/**
 * Error page.  Used when the payment is cancelled or an error occurs.
 */
app.get('/error', (req, res) => {
  res.render('error', { message: 'An error occurred or the payment was cancelled.' });
});

/**
 * Generate a PDF document containing the data from the notice form.
 * @param {Object} data – The metadata stored in the Stripe session.
 * @returns {Promise<Buffer>} A Promise resolving with a buffer containing the PDF.
 */
function generatePdf(data) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ autoFirstPage: false });
      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => {
        const pdfData = Buffer.concat(buffers);
        resolve(pdfData);
      });
      // Add a page
      doc.addPage({ size: 'A4', margin: 50 });
      doc.fontSize(16).text('UK Landlord Legal Notice', { align: 'center' });
      doc.moveDown();
      // Document title
      const typeTitle = getNoticeConfig(data.type || '').name || 'Notice';
      doc.fontSize(14).text(typeTitle, { align: 'center' });
      doc.moveDown();
      doc.fontSize(12);
      doc.text(`Date: ${new Date().toLocaleDateString('en-GB')}`, { align: 'right' });
      doc.moveDown();

      // Landlord details
      doc.font('Helvetica-Bold').text('Landlord Details');
      doc.font('Helvetica').text(`Name: ${data.landlordName || ''}`);
      doc.text(`Address: ${data.landlordAddress || ''}`);
      doc.moveDown();

      // Tenant details
      doc.font('Helvetica-Bold').text('Tenant Details');
      doc.font('Helvetica').text(`Name: ${data.tenantName || ''}`);
      doc.text(`Address: ${data.tenantAddress || ''}`);
      doc.moveDown();

      // Property details
      doc.font('Helvetica-Bold').text('Property Details');
      doc.font('Helvetica').text(`Address: ${data.propertyAddress || ''}`);
      doc.text(`Tenancy Start Date: ${data.tenancyStart || ''}`);
      doc.text(`Notice End Date: ${data.noticeEnd || ''}`);
      if (data.reason) {
        doc.text(`Reason (if applicable): ${data.reason}`);
      }
      doc.moveDown();

      // Disclaimer
      doc.font('Helvetica-Bold').text('Disclaimer');
      doc.font('Helvetica').text(
        'This document was generated using an automated service based on official government templates. It does not constitute legal advice. ' +
        'Please review the contents carefully and ensure it meets your specific circumstances. For legal advice, consult a qualified solicitor.'
      );
      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

// Start the server.
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on http://localhost:${port}`);
});
