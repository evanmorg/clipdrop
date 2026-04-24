require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET;

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname)); // serve HTML files

// ─── Auth middleware ──────────────────────────────────────────────────────────
function authMiddleware(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
}

function adminOnly(req, res, next) {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin only' });
  next();
}

// ─── Helper ───────────────────────────────────────────────────────────────────
function generateRef() {
  return 'CD-' + Math.floor(10000 + Math.random() * 90000);
}

// ══════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// Register seller
app.post('/api/auth/register/seller', async (req, res) => {
  const { email, password, first_name, last_name } = req.body;
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const user = db.prepare(
      'INSERT INTO users (email, password, role, first_name, last_name) VALUES (?, ?, ?, ?, ?)'
    ).run(email, hash, 'seller', first_name, last_name);

    db.prepare('INSERT INTO sellers (user_id) VALUES (?)').run(user.lastInsertRowid);

    const token = jwt.sign({ id: user.lastInsertRowid, role: 'seller', email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.lastInsertRowid, email, role: 'seller', first_name, last_name } });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email already registered' });
    res.status(500).json({ error: e.message });
  }
});

// Register creator
app.post('/api/auth/register/creator', async (req, res) => {
  const {
    email, password, first_name, last_name,
    handle_tiktok, handle_instagram, followers_tiktok, followers_instagram,
    niches, formats, rate, turnaround, portfolio_links, bio,
    address_line1, address_line2, city, state, zip, country
  } = req.body;

  if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

  try {
    const hash = bcrypt.hashSync(password, 10);
    const user = db.prepare(
      'INSERT INTO users (email, password, role, first_name, last_name) VALUES (?, ?, ?, ?, ?)'
    ).run(email, hash, 'creator', first_name, last_name);

    db.prepare(`
      INSERT INTO creators (
        user_id, handle_tiktok, handle_instagram, followers_tiktok, followers_instagram,
        niches, formats, rate, turnaround, portfolio_links, bio,
        address_line1, address_line2, city, state, zip, country
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      user.lastInsertRowid,
      handle_tiktok, handle_instagram, followers_tiktok, followers_instagram,
      JSON.stringify(niches), JSON.stringify(formats),
      rate, turnaround, JSON.stringify(portfolio_links), bio,
      address_line1, address_line2, city, state, zip, country
    );

    const token = jwt.sign({ id: user.lastInsertRowid, role: 'creator', email }, JWT_SECRET, { expiresIn: '7d' });
    res.json({ token, user: { id: user.lastInsertRowid, email, role: 'creator', first_name, last_name } });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Email already registered' });
    res.status(500).json({ error: e.message });
  }
});

// Login
app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!user || !bcrypt.compareSync(password, user.password)) {
    return res.status(401).json({ error: 'Invalid email or password' });
  }
  const token = jwt.sign({ id: user.id, role: user.role, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
  res.json({ token, user: { id: user.id, email: user.email, role: user.role, first_name: user.first_name, last_name: user.last_name } });
});

// ══════════════════════════════════════════════════════════════════════════════
// ORDERS ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// Create payment intent (called before placing order)
app.post('/api/orders/payment-intent', authMiddleware, async (req, res) => {
  const { amount } = req.body; // amount in dollars
  try {
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount * 100, // convert to cents
      currency: 'usd',
      metadata: { integration_check: 'accept_a_payment' },
    });
    res.json({ clientSecret: paymentIntent.client_secret, id: paymentIntent.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Place order
app.post('/api/orders', authMiddleware, (req, res) => {
  const {
    product_name, product_url, product_desc, product_category,
    target_audience, ad_style, video_length, reference_links,
    special_instructions, product_variant, quantity, shipping_speed,
    match_type, creator_id, amount, stripe_payment_intent_id
  } = req.body;

  const seller = db.prepare('SELECT id FROM sellers WHERE user_id = ?').get(req.user.id);
  if (!seller) return res.status(400).json({ error: 'Seller account not found' });

  const platform_fee = Math.round(amount * 0.23);
  const creator_payout = Math.round(amount * 0.65);
  const reference = generateRef();

  try {
    const order = db.prepare(`
      INSERT INTO orders (
        reference, seller_id, creator_id, product_name, product_url, product_desc,
        product_category, target_audience, ad_style, video_length, reference_links,
        special_instructions, product_variant, quantity, shipping_speed,
        match_type, amount, platform_fee, creator_payout, stripe_payment_intent_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      reference, seller.id, creator_id || null,
      product_name, product_url, product_desc, product_category,
      target_audience, ad_style, video_length,
      JSON.stringify(reference_links), special_instructions,
      product_variant, quantity, shipping_speed, match_type,
      amount, platform_fee, creator_payout, stripe_payment_intent_id
    );

    // Create a pending payout record
    if (creator_id) {
      const creator = db.prepare('SELECT id FROM creators WHERE id = ?').get(creator_id);
      if (creator) {
        db.prepare('INSERT INTO payouts (order_id, creator_id, amount) VALUES (?, ?, ?)')
          .run(order.lastInsertRowid, creator_id, creator_payout);
      }
    }

    res.json({ success: true, reference, order_id: order.lastInsertRowid });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Get orders for logged-in seller
app.get('/api/orders/my', authMiddleware, (req, res) => {
  const seller = db.prepare('SELECT id FROM sellers WHERE user_id = ?').get(req.user.id);
  if (!seller) return res.status(400).json({ error: 'Seller not found' });
  const orders = db.prepare('SELECT * FROM orders WHERE seller_id = ? ORDER BY created_at DESC').all(seller.id);
  res.json(orders);
});

// Update order status (admin)
app.patch('/api/orders/:id/status', authMiddleware, adminOnly, (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(status, req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// CREATORS ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// Get all active creators (for seller browsing)
app.get('/api/creators', authMiddleware, (req, res) => {
  const creators = db.prepare(`
    SELECT c.*, u.first_name, u.last_name, u.email
    FROM creators c JOIN users u ON c.user_id = u.id
    WHERE c.status = 'active'
    ORDER BY c.created_at DESC
  `).all();
  res.json(creators);
});

// Get all creators (admin)
app.get('/api/admin/creators', authMiddleware, adminOnly, (req, res) => {
  const creators = db.prepare(`
    SELECT c.*, u.first_name, u.last_name, u.email
    FROM creators c JOIN users u ON c.user_id = u.id
    ORDER BY c.created_at DESC
  `).all();
  res.json(creators);
});

// Approve or reject creator (admin)
app.patch('/api/admin/creators/:id/status', authMiddleware, adminOnly, (req, res) => {
  const { status } = req.body;
  db.prepare('UPDATE creators SET status = ? WHERE id = ?').run(status, req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// SELLERS ROUTES (admin)
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/sellers', authMiddleware, adminOnly, (req, res) => {
  const sellers = db.prepare(`
    SELECT s.*, u.first_name, u.last_name, u.email,
      COUNT(o.id) as order_count,
      COALESCE(SUM(o.amount), 0) as total_spent
    FROM sellers s
    JOIN users u ON s.user_id = u.id
    LEFT JOIN orders o ON o.seller_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
  `).all();
  res.json(sellers);
});

// Update seller plan (admin)
app.patch('/api/admin/sellers/:id/plan', authMiddleware, adminOnly, (req, res) => {
  const { plan } = req.body;
  db.prepare('UPDATE sellers SET plan = ? WHERE id = ?').run(plan, req.params.id);
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// PAYOUTS ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// Get all pending payouts (admin)
app.get('/api/admin/payouts', authMiddleware, adminOnly, (req, res) => {
  const payouts = db.prepare(`
    SELECT p.*, u.first_name, u.last_name, o.reference, o.product_name
    FROM payouts p
    JOIN creators c ON p.creator_id = c.id
    JOIN users u ON c.user_id = u.id
    JOIN orders o ON p.order_id = o.id
    WHERE p.status = 'pending'
    ORDER BY p.created_at DESC
  `).all();
  res.json(payouts);
});

// Pay a single creator (admin)
app.post('/api/admin/payouts/:id/pay', authMiddleware, adminOnly, async (req, res) => {
  const payout = db.prepare('SELECT * FROM payouts WHERE id = ?').get(req.params.id);
  if (!payout) return res.status(404).json({ error: 'Payout not found' });

  const creator = db.prepare('SELECT * FROM creators WHERE id = ?').get(payout.creator_id);
  if (!creator?.stripe_account_id) {
    // Mark as paid manually if no Stripe account connected yet
    db.prepare('UPDATE payouts SET status = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('paid', payout.id);
    return res.json({ success: true, note: 'Marked as paid — creator has no Stripe account connected yet' });
  }

  try {
    const transfer = await stripe.transfers.create({
      amount: payout.amount * 100,
      currency: 'usd',
      destination: creator.stripe_account_id,
    });

    db.prepare('UPDATE payouts SET status = ?, stripe_transfer_id = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run('paid', transfer.id, payout.id);

    res.json({ success: true, transfer_id: transfer.id });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pay all pending payouts (admin)
app.post('/api/admin/payouts/pay-all', authMiddleware, adminOnly, async (req, res) => {
  const pending = db.prepare(`
    SELECT p.*, c.stripe_account_id FROM payouts p
    JOIN creators c ON p.creator_id = c.id
    WHERE p.status = 'pending'
  `).all();

  let paid = 0, failed = 0;
  for (const payout of pending) {
    try {
      if (payout.stripe_account_id) {
        const transfer = await stripe.transfers.create({
          amount: payout.amount * 100,
          currency: 'usd',
          destination: payout.stripe_account_id,
        });
        db.prepare('UPDATE payouts SET status = ?, stripe_transfer_id = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run('paid', transfer.id, payout.id);
      } else {
        db.prepare('UPDATE payouts SET status = ?, paid_at = CURRENT_TIMESTAMP WHERE id = ?')
          .run('paid', payout.id);
      }
      paid++;
    } catch {
      failed++;
    }
  }

  res.json({ success: true, paid, failed });
});

// ══════════════════════════════════════════════════════════════════════════════
// DISPUTES ROUTES
// ══════════════════════════════════════════════════════════════════════════════

// Raise a dispute
app.post('/api/disputes', authMiddleware, (req, res) => {
  const { order_id, reason } = req.body;
  db.prepare('INSERT INTO disputes (order_id, raised_by, reason) VALUES (?, ?, ?)')
    .run(order_id, req.user.id, reason);
  db.prepare("UPDATE orders SET status = 'disputed', updated_at = CURRENT_TIMESTAMP WHERE id = ?")
    .run(order_id);
  res.json({ success: true });
});

// Get all disputes (admin)
app.get('/api/admin/disputes', authMiddleware, adminOnly, (req, res) => {
  const disputes = db.prepare(`
    SELECT d.*, o.reference, o.product_name,
      u.first_name || ' ' || u.last_name as raised_by_name
    FROM disputes d
    JOIN orders o ON d.order_id = o.id
    JOIN users u ON d.raised_by = u.id
    ORDER BY d.created_at DESC
  `).all();
  res.json(disputes);
});

// Resolve a dispute (admin)
app.patch('/api/admin/disputes/:id/resolve', authMiddleware, adminOnly, (req, res) => {
  const { resolution, order_status } = req.body;
  db.prepare('UPDATE disputes SET status = ?, resolution = ?, resolved_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run('resolved', resolution, req.params.id);

  const dispute = db.prepare('SELECT order_id FROM disputes WHERE id = ?').get(req.params.id);
  if (dispute && order_status) {
    db.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(order_status, dispute.order_id);
  }
  res.json({ success: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN STATS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/api/admin/stats', authMiddleware, adminOnly, (req, res) => {
  const revenue = db.prepare("SELECT COALESCE(SUM(amount),0) as total FROM orders WHERE status != 'refunded'").get();
  const fees = db.prepare("SELECT COALESCE(SUM(platform_fee),0) as total FROM orders WHERE status != 'refunded'").get();
  const payouts_total = db.prepare("SELECT COALESCE(SUM(creator_payout),0) as total FROM orders WHERE status = 'completed'").get();
  const orders_total = db.prepare('SELECT COUNT(*) as count FROM orders').get();
  const orders_active = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status IN ('shipping','filming','in_review')").get();
  const orders_completed = db.prepare("SELECT COUNT(*) as count FROM orders WHERE status = 'completed'").get();
  const creators_total = db.prepare('SELECT COUNT(*) as count FROM creators').get();
  const creators_pending = db.prepare("SELECT COUNT(*) as count FROM creators WHERE status = 'pending'").get();
  const sellers_total = db.prepare('SELECT COUNT(*) as count FROM sellers').get();
  const disputes_open = db.prepare("SELECT COUNT(*) as count FROM disputes WHERE status = 'open'").get();
  const payouts_pending = db.prepare("SELECT COUNT(*) as count, COALESCE(SUM(amount),0) as total FROM payouts WHERE status = 'pending'").get();

  res.json({
    revenue: revenue.total,
    platform_fees: fees.total,
    creator_payouts: payouts_total.total,
    orders: { total: orders_total.count, active: orders_active.count, completed: orders_completed.count },
    creators: { total: creators_total.count, pending: creators_pending.count },
    sellers: { total: sellers_total.count },
    disputes: { open: disputes_open.count },
    payouts_pending: { count: payouts_pending.count, total: payouts_pending.total }
  });
});

// Expose publishable key safely to frontend
app.get('/api/stripe-key', (req, res) => {
  res.json({ publishableKey: process.env.STRIPE_PUBLISHABLE_KEY });
});

// ─── Catch-all: serve index.html ─────────────────────────────────────────────
app.get('/{*path}', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ─── Start server ─────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`
  ╔════════════════════════════════╗
  ║   ClipDrop server running      ║
  ║   http://localhost:${PORT}        ║
  ╚════════════════════════════════╝
  `);
});
