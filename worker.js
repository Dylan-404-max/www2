// TIMBER BUSINESS MANAGEMENT SYSTEM - CLOUDFLARE WORKER BACKEND
// API Routes & Business Logic

// ==================== CONFIGURATION ====================
const JWT_SECRET = 'your-jwt-secret-change-in-production'; // Change this!
const JWT_EXPIRY = '7d';

// ==================== UTILITY FUNCTIONS ====================

async function hashPassword(password) {
  const encoder = new TextEncoder();
  const data = encoder.encode(password + JWT_SECRET);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function verifyPassword(password, hash) {
  const hashed = await hashPassword(password);
  return hashed === hash;
}

async function signJWT(payload, secret) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const encodedHeader = btoa(JSON.stringify(header));
  const encodedPayload = btoa(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + 604800 }));
  const signature = await crypto.subtle.sign(
    { name: 'HMAC', hash: 'SHA-256' },
    await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
    new TextEncoder().encode(`${encodedHeader}.${encodedPayload}`)
  );
  const encodedSignature = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
}

async function verifyJWT(token, secret) {
  try {
    const [header, payload, signature] = token.split('.');
    const expectedSignature = await crypto.subtle.sign(
      { name: 'HMAC', hash: 'SHA-256' },
      await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
      new TextEncoder().encode(`${header}.${payload}`)
    );
    const expectedSig = btoa(String.fromCharCode(...new Uint8Array(expectedSignature)));
    if (signature !== expectedSig) return null;
    const decoded = JSON.parse(atob(payload));
    if (decoded.exp < Math.floor(Date.now() / 1000)) return null;
    return decoded;
  } catch (e) {
    return null;
  }
}

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization'
    }
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ success: false, error: message }, status);
}

// ==================== MIDDLEWARE ====================

async function authMiddleware(request, env) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { user: null, error: 'Missing token' };
  }
  const token = authHeader.substring(7);
  const decoded = await verifyJWT(token, JWT_SECRET);
  if (!decoded) {
    return { user: null, error: 'Invalid token' };
  }
  const user = await env.DB.prepare('SELECT u.*, r.name as role_name, r.permissions FROM users u JOIN roles r ON u.role_id = r.id WHERE u.id = ?')
    .bind(decoded.userId).first();
  if (!user || !user.is_active) {
    return { user: null, error: 'User not found or inactive' };
  }
  return { user, error: null };
}

function checkPermission(user, permission) {
  if (user.role_name === 'admin') return true;
  const permissions = JSON.parse(user.permissions || '[]');
  if (permissions.includes('*')) return true;
  return permissions.includes(permission);
}

function requireAuth(handler) {
  return async (request, env, params) => {
    const { user, error } = await authMiddleware(request, env);
    if (error) return errorResponse(error, 401);
    request.user = user;
    return handler(request, env, params);
  };
}

function requirePermission(permission) {
  return (handler) => {
    return requireAuth(async (request, env, params) => {
      if (!checkPermission(request.user, permission)) {
        return errorResponse('Insufficient permissions', 403);
      }
      return handler(request, env, params);
    });
  };
}

// ==================== AUDIT LOG HELPER ====================

async function logAudit(env, userId, action, entityType, entityId, oldValues, newValues, request) {
  await env.DB.prepare(`INSERT INTO audit_logs (user_id, action, entity_type, entity_id, old_values, new_values, ip_address, user_agent) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(userId, action, entityType, entityId, 
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      request.headers.get('CF-Connecting-IP') || 'unknown',
      request.headers.get('User-Agent') || 'unknown'
    ).run();
}

// ==================== INVOICE NUMBER GENERATOR ====================

async function generateInvoiceNumber(env, branchId) {
  const date = new Date();
  const prefix = `INV-${branchId}-${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}`;
  const count = await env.DB.prepare(`SELECT COUNT(*) as count FROM sales WHERE invoice_number LIKE ?`)
    .bind(`${prefix}%`).first();
  return `${prefix}-${String(count.count + 1).padStart(4, '0')}`;
}

async function generateOrderNumber(env, branchId) {
  const date = new Date();
  const prefix = `ORD-${branchId}-${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}`;
  const count = await env.DB.prepare(`SELECT COUNT(*) as count FROM orders WHERE order_number LIKE ?`)
    .bind(`${prefix}%`).first();
  return `${prefix}-${String(count.count + 1).padStart(4, '0')}`;
}

async function generateDraftNumber(env, branchId) {
  const date = new Date();
  const prefix = `DRF-${branchId}-${date.getFullYear()}${String(date.getMonth()+1).padStart(2,'0')}`;
  const count = await env.DB.prepare(`SELECT COUNT(*) as count FROM drafts WHERE draft_number LIKE ?`)
    .bind(`${prefix}%`).first();
  return `${prefix}-${String(count.count + 1).padStart(4, '0')}`;
}

// ==================== NOTIFICATION HELPER ====================

async function createNotification(env, userId, branchId, type, title, message, data = null) {
  await env.DB.prepare(`INSERT INTO notifications (user_id, branch_id, type, title, message, data) 
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(userId, branchId, type, title, message, data ? JSON.stringify(data) : null).run();
}

// ==================== ROUTER SETUP ====================

// ==================== SIMPLE ROUTER ====================

class Router {
  constructor() {
    this.routes = [];
  }

  get(pattern, handler) {
    this.routes.push({ method: 'GET', pattern, handler });
  }

  post(pattern, handler) {
    this.routes.push({ method: 'POST', pattern, handler });
  }

  put(pattern, handler) {
    this.routes.push({ method: 'PUT', pattern, handler });
  }

  delete(pattern, handler) {
    this.routes.push({ method: 'DELETE', pattern, handler });
  }

  async handle(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    for (const route of this.routes) {
      if (route.method !== method) continue;

      const match = this.matchPath(route.pattern, path);
      if (match) {
        try {
          return await route.handler(request, env, match.params);
        } catch (error) {
          console.error('Route error:', error);
          return errorResponse(error.message || 'Internal server error', 500);
        }
      }
    }

    return errorResponse('Not found', 404);
  }

  matchPath(pattern, path) {
    const patternParts = pattern.split('/').filter(p => p);
    const pathParts = path.split('/').filter(p => p);

    if (patternParts.length !== pathParts.length) return null;

    const params = {};
    for (let i = 0; i < patternParts.length; i++) {
      if (patternParts[i].startsWith(':')) {
        params[patternParts[i].substring(1)] = pathParts[i];
      } else if (patternParts[i] !== pathParts[i]) {
        return null;
      }
    }

    return { params };
  }
}



const router = new Router();

// ==================== AUTH ROUTES ====================

router.post('/api/auth/login', async (request, env) => {
  const { username, password } = await request.json();
  if (!username || !password) return errorResponse('Username and password required');

  const user = await env.DB.prepare('SELECT u.*, r.name as role_name, r.permissions FROM users u JOIN roles r ON u.role_id = r.id WHERE u.username = ?')
    .bind(username).first();

  if (!user) return errorResponse('Invalid credentials', 401);

  const validPass = await verifyPassword(password, user.password_hash);
  if (!validPass) return errorResponse('Invalid credentials', 401);

  if (!user.is_active) return errorResponse('Account is deactivated', 403);

  await env.DB.prepare('UPDATE users SET last_login = CURRENT_TIMESTAMP WHERE id = ?').bind(user.id).run();

  const token = await signJWT({ userId: user.id, username: user.username, role: user.role_name }, JWT_SECRET);

  return jsonResponse({
    success: true,
    token,
    user: {
      id: user.id,
      username: user.username,
      full_name: user.full_name,
      role: user.role_name,
      role_id: user.role_id,
      branch_id: user.branch_id,
      permissions: JSON.parse(user.permissions || '[]')
    }
  });
});

router.get('/api/auth/me', requireAuth(async (request, env) => {
  return jsonResponse({ success: true, user: request.user });
}));

// ==================== BRANCHES ====================

router.get('/api/branches', requireAuth(async (request, env) => {
  const branches = await env.DB.prepare('SELECT * FROM branches WHERE is_active = 1').all();
  return jsonResponse({ success: true, branches: branches.results });
}));

router.post('/api/branches', requirePermission('branches')(async (request, env) => {
  const { name, location, phone, email } = await request.json();
  const result = await env.DB.prepare('INSERT INTO branches (name, location, phone, email) VALUES (?, ?, ?, ?)')
    .bind(name, location, phone, email).run();
  await logAudit(env, request.user.id, 'create', 'branch', result.meta.last_row_id, null, { name, location }, request);
  return jsonResponse({ success: true, id: result.meta.last_row_id });
}));

router.put('/api/branches/:id', requirePermission('branches')(async (request, env, params) => {
  const { name, location, phone, email, is_active } = await request.json();
  const old = await env.DB.prepare('SELECT * FROM branches WHERE id = ?').bind(params.id).first();
  await env.DB.prepare('UPDATE branches SET name = ?, location = ?, phone = ?, email = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(name, location, phone, email, is_active, params.id).run();
  await logAudit(env, request.user.id, 'update', 'branch', params.id, old, { name, location, is_active }, request);
  return jsonResponse({ success: true });
}));

// ==================== PRODUCTS ====================

router.get('/api/products', requireAuth(async (request, env) => {
  const products = await env.DB.prepare('SELECT * FROM products WHERE is_deleted = 0 ORDER BY name').all();
  return jsonResponse({ success: true, products: products.results });
}));

router.get('/api/products/:id', requireAuth(async (request, env, params) => {
  const product = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(params.id).first();
  if (!product) return errorResponse('Product not found', 404);
  return jsonResponse({ success: true, product });
}));

router.post('/api/products', requirePermission('products')(async (request, env) => {
  const { name, description, unit, price, cost_price, stock_threshold, category } = await request.json();
  const result = await env.DB.prepare(`INSERT INTO products (name, description, unit, price, cost_price, stock_threshold, category) 
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(name, description, unit || 'piece', price, cost_price || 0, stock_threshold || 10, category || 'timber').run();
  await logAudit(env, request.user.id, 'create', 'product', result.meta.last_row_id, null, { name, price }, request);
  return jsonResponse({ success: true, id: result.meta.last_row_id });
}));

router.put('/api/products/:id', requirePermission('products')(async (request, env, params) => {
  const { name, description, unit, price, cost_price, stock_threshold, category, is_active } = await request.json();
  const old = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(params.id).first();
  await env.DB.prepare(`UPDATE products SET name = ?, description = ?, unit = ?, price = ?, cost_price = ?, 
    stock_threshold = ?, category = ?, is_active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
    .bind(name, description, unit, price, cost_price, stock_threshold, category, is_active, params.id).run();
  await logAudit(env, request.user.id, 'update', 'product', params.id, old, { name, price, is_active }, request);
  return jsonResponse({ success: true });
}));

router.delete('/api/products/:id', requirePermission('products')(async (request, env, params) => {
  const old = await env.DB.prepare('SELECT * FROM products WHERE id = ?').bind(params.id).first();
  await env.DB.prepare('UPDATE products SET is_deleted = 1, is_active = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(params.id).run();
  await logAudit(env, request.user.id, 'soft_delete', 'product', params.id, old, null, request);
  return jsonResponse({ success: true });
}));

// ==================== SERVICES ====================

router.get('/api/services', requireAuth(async (request, env) => {
  const services = await env.DB.prepare('SELECT * FROM services WHERE is_deleted = 0 ORDER BY name').all();
  return jsonResponse({ success: true, services: services.results });
}));

router.post('/api/services', requirePermission('services')(async (request, env) => {
  const { name, description, price } = await request.json();
  const result = await env.DB.prepare('INSERT INTO services (name, description, price) VALUES (?, ?, ?)')
    .bind(name, description, price).run();
  await logAudit(env, request.user.id, 'create', 'service', result.meta.last_row_id, null, { name, price }, request);
  return jsonResponse({ success: true, id: result.meta.last_row_id });
}));

router.put('/api/services/:id', requirePermission('services')(async (request, env, params) => {
  const { name, description, price, is_active } = await request.json();
  await env.DB.prepare('UPDATE services SET name = ?, description = ?, price = ?, is_active = ? WHERE id = ?')
    .bind(name, description, price, is_active, params.id).run();
  return jsonResponse({ success: true });
}));

router.delete('/api/services/:id', requirePermission('services')(async (request, env, params) => {
  await env.DB.prepare('UPDATE services SET is_deleted = 1, is_active = 0 WHERE id = ?').bind(params.id).run();
  return jsonResponse({ success: true });
}));

// ==================== STOCK / INVENTORY ====================

router.get('/api/inventory', requireAuth(async (request, env) => {
  const branchId = request.user.branch_id;
  const isAdmin = request.user.role_name === 'admin';

  let query = `SELECT s.*, p.name as product_name, p.unit, p.price, p.stock_threshold, p.is_active 
    FROM stock s JOIN products p ON s.product_id = p.id WHERE p.is_deleted = 0`;
  if (!isAdmin) query += ` AND s.branch_id = ?`;
  query += ` ORDER BY p.name`;

  const stmt = isAdmin ? env.DB.prepare(query) : env.DB.prepare(query).bind(branchId);
  const stock = await stmt.all();
  return jsonResponse({ success: true, inventory: stock.results });
}));

router.post('/api/inventory/receive', requirePermission('inventory')(async (request, env) => {
  const { product_id, branch_id, quantity, cost_price, supplier, notes } = await request.json();
  const targetBranch = request.user.role_name === 'admin' ? branch_id : (request.user.branch_id || branch_id);

  const existing = await env.DB.prepare('SELECT * FROM stock WHERE product_id = ? AND branch_id = ?')
    .bind(product_id, targetBranch).first();

  if (existing) {
    const newQty = existing.quantity + quantity;
    await env.DB.prepare('UPDATE stock SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .bind(newQty, existing.id).run();
  } else {
    await env.DB.prepare('INSERT INTO stock (product_id, branch_id, quantity) VALUES (?, ?, ?)')
      .bind(product_id, targetBranch, quantity).run();
  }

  await env.DB.prepare(`INSERT INTO stock_movements (product_id, branch_id, type, quantity, previous_quantity, 
    new_quantity, reference_type, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(product_id, targetBranch, 'in', quantity, existing ? existing.quantity : 0, 
      existing ? existing.quantity + quantity : quantity, 'inventory', notes, request.user.id).run();

  await logAudit(env, request.user.id, 'receive_stock', 'stock', product_id, 
    { quantity: existing ? existing.quantity : 0 }, { quantity: existing ? existing.quantity + quantity : quantity }, request);

  return jsonResponse({ success: true });
}));

router.get('/api/inventory/movements', requireAuth(async (request, env) => {
  const branchId = request.user.branch_id;
  const isAdmin = request.user.role_name === 'admin';

  let query = `SELECT sm.*, p.name as product_name, u.full_name as created_by_name 
    FROM stock_movements sm JOIN products p ON sm.product_id = p.id 
    LEFT JOIN users u ON sm.created_by = u.id WHERE 1=1`;
  if (!isAdmin) query += ` AND sm.branch_id = ?`;
  query += ` ORDER BY sm.created_at DESC LIMIT 100`;

  const stmt = isAdmin ? env.DB.prepare(query) : env.DB.prepare(query).bind(branchId);
  const movements = await stmt.all();
  return jsonResponse({ success: true, movements: movements.results });
}));

// ==================== SALES ====================

router.get('/api/sales', requireAuth(async (request, env) => {
  const branchId = request.user.branch_id;
  const isAdmin = request.user.role_name === 'admin';
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit')) || 50;
  const offset = parseInt(url.searchParams.get('offset')) || 0;
  const status = url.searchParams.get('status');
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');

  let query = `SELECT s.*, b.name as branch_name, u.full_name as user_name, c.name as customer_name 
    FROM sales s LEFT JOIN branches b ON s.branch_id = b.id 
    LEFT JOIN users u ON s.user_id = u.id LEFT JOIN customers c ON s.customer_id = c.id WHERE 1=1`;
  let countQuery = `SELECT COUNT(*) as total FROM sales WHERE 1=1`;

  if (!isAdmin) {
    query += ` AND s.branch_id = ?`;
    countQuery += ` AND branch_id = ?`;
  }
  if (status) {
    query += ` AND s.status = ?`;
    countQuery += ` AND status = ?`;
  }
  if (dateFrom && dateTo) {
    query += ` AND DATE(s.created_at) BETWEEN ? AND ?`;
    countQuery += ` AND DATE(created_at) BETWEEN ? AND ?`;
  }
  query += ` ORDER BY s.created_at DESC LIMIT ? OFFSET ?`;

  let stmt = isAdmin ? env.DB.prepare(query) : env.DB.prepare(query).bind(branchId, limit, offset);
  if (!isAdmin && status) stmt = env.DB.prepare(query).bind(branchId, status, limit, offset);
  else if (isAdmin && status) stmt = env.DB.prepare(query).bind(status, limit, offset);

  if (dateFrom && dateTo) {
    if (!isAdmin && status) stmt = env.DB.prepare(query).bind(branchId, status, dateFrom, dateTo, limit, offset);
    else if (isAdmin && status) stmt = env.DB.prepare(query).bind(status, dateFrom, dateTo, limit, offset);
    else if (!isAdmin) stmt = env.DB.prepare(query).bind(branchId, dateFrom, dateTo, limit, offset);
    else stmt = env.DB.prepare(query).bind(dateFrom, dateTo, limit, offset);
  }

  const sales = await stmt.all();

  // Get items for each sale
  for (let sale of sales.results) {
    const items = await env.DB.prepare('SELECT * FROM sale_items WHERE sale_id = ?').bind(sale.id).all();
    sale.items = items.results;
  }

  return jsonResponse({ success: true, sales: sales.results });
}));

router.get('/api/sales/:id', requireAuth(async (request, env, params) => {
  const sale = await env.DB.prepare(`SELECT s.*, b.name as branch_name, u.full_name as user_name, c.name as customer_name 
    FROM sales s LEFT JOIN branches b ON s.branch_id = b.id 
    LEFT JOIN users u ON s.user_id = u.id LEFT JOIN customers c ON s.customer_id = c.id WHERE s.id = ?`)
    .bind(params.id).first();
  if (!sale) return errorResponse('Sale not found', 404);

  const items = await env.DB.prepare('SELECT * FROM sale_items WHERE sale_id = ?').bind(params.id).all();
  sale.items = items.results;

  return jsonResponse({ success: true, sale });
}));

router.post('/api/sales', requirePermission('sales')(async (request, env) => {
  const { customer_id, customer_name, items, payment_method, notes, status, sale_date } = await request.json();
  const branchId = request.user.branch_id;
  const userId = request.user.id;

  if (!items || items.length === 0) return errorResponse('No items in sale');

  const invoiceNumber = await generateInvoiceNumber(env, branchId);

  let subtotal = 0;
  items.forEach(item => {
    subtotal += item.quantity * item.unit_price;
  });

  const totalAmount = subtotal;
  const saleStatus = status || 'completed';
  const createdAt = sale_date || new Date().toISOString();

  const result = await env.DB.prepare(`INSERT INTO sales 
    (invoice_number, customer_id, customer_name, branch_id, user_id, subtotal, total_amount, 
    payment_method, status, notes, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(invoiceNumber, customer_id || null, customer_name || null, branchId, userId, subtotal, totalAmount, 
      payment_method || 'cash', saleStatus, notes || null, createdAt).run();

  const saleId = result.meta.last_row_id;

  // Insert sale items and update stock
  for (const item of items) {
    await env.DB.prepare(`INSERT INTO sale_items (sale_id, product_id, service_id, item_type, name, quantity, unit_price, total_price) 
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(saleId, item.product_id || null, item.service_id || null, item.item_type, item.name, 
        item.quantity, item.unit_price, item.quantity * item.unit_price).run();

    // Update stock for products only (not services)
    if (item.item_type === 'product' && item.product_id && saleStatus === 'completed') {
      const stock = await env.DB.prepare('SELECT * FROM stock WHERE product_id = ? AND branch_id = ?')
        .bind(item.product_id, branchId).first();

      if (stock) {
        const newQty = stock.quantity - item.quantity;
        await env.DB.prepare('UPDATE stock SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind(newQty, stock.id).run();

        await env.DB.prepare(`INSERT INTO stock_movements (product_id, branch_id, type, quantity, previous_quantity, 
          new_quantity, reference_type, reference_id, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .bind(item.product_id, branchId, 'out', item.quantity, stock.quantity, newQty, 'sale', saleId, userId).run();
      }
    }
  }

  // Update customer stats
  if (customer_id) {
    await env.DB.prepare(`UPDATE customers SET total_purchases = total_purchases + ?, last_purchase = ? WHERE id = ?`)
      .bind(totalAmount, createdAt, customer_id).run();
  }

  await logAudit(env, userId, 'create', 'sale', saleId, null, { invoice_number: invoiceNumber, total: totalAmount, date: createdAt }, request);

  // Create notification for admin/managers
  const admins = await env.DB.prepare('SELECT id FROM users WHERE role_id = 1 OR (role_id = 2 AND branch_id = ?)').bind(branchId).all();
  for (const admin of admins.results) {
    await createNotification(env, admin.id, branchId, 'sale', 'New Sale', 
      `Sale ${invoiceNumber} completed for ${totalAmount.toFixed(2)}`, { sale_id: saleId, amount: totalAmount });
  }

  return jsonResponse({ success: true, sale_id: saleId, invoice_number: invoiceNumber, created_at: createdAt });
}));

router.put('/api/sales/:id/cancel', requirePermission('sales')(async (request, env, params) => {
  const sale = await env.DB.prepare('SELECT * FROM sales WHERE id = ?').bind(params.id).first();
  if (!sale) return errorResponse('Sale not found', 404);
  if (sale.status === 'cancelled') return errorResponse('Sale already cancelled');

  await env.DB.prepare('UPDATE sales SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind('cancelled', params.id).run();

  // Restore stock for cancelled sales
  if (sale.status === 'completed') {
    const items = await env.DB.prepare('SELECT * FROM sale_items WHERE sale_id = ? AND item_type = ?')
      .bind(params.id, 'product').all();
    for (const item of items.results) {
      const stock = await env.DB.prepare('SELECT * FROM stock WHERE product_id = ? AND branch_id = ?')
        .bind(item.product_id, sale.branch_id).first();
      if (stock) {
        const newQty = stock.quantity + item.quantity;
        await env.DB.prepare('UPDATE stock SET quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind(newQty, stock.id).run();
      }
    }
  }

  await logAudit(env, request.user.id, 'cancel', 'sale', params.id, sale, { status: 'cancelled' }, request);
  return jsonResponse({ success: true });
}));

// ==================== DRAFTS ====================

router.get('/api/drafts', requireAuth(async (request, env) => {
  const branchId = request.user.branch_id;
  const userId = request.user.id;
  const isAdmin = request.user.role_name === 'admin';

  let query = 'SELECT * FROM drafts WHERE 1=1';
  if (!isAdmin) query += ' AND branch_id = ? AND user_id = ?';
  query += ' ORDER BY updated_at DESC';

  const stmt = isAdmin ? env.DB.prepare(query) : env.DB.prepare(query).bind(branchId, userId);
  const drafts = await stmt.all();
  return jsonResponse({ success: true, drafts: drafts.results });
}));

router.post('/api/drafts', requirePermission('sales')(async (request, env) => {
  const { customer_id, customer_name, items, notes } = await request.json();
  const branchId = request.user.branch_id;
  const userId = request.user.id;

  const draftNumber = await generateDraftNumber(env, branchId);
  let subtotal = 0;
  items.forEach(item => subtotal += item.quantity * item.unit_price);

  const result = await env.DB.prepare(`INSERT INTO drafts (draft_number, customer_id, customer_name, branch_id, user_id, items, subtotal, total_amount, notes) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(draftNumber, customer_id || null, customer_name || null, branchId, userId, JSON.stringify(items), 
      subtotal, subtotal, notes || null).run();

  return jsonResponse({ success: true, draft_id: result.meta.last_row_id, draft_number: draftNumber });
}));

router.delete('/api/drafts/:id', requireAuth(async (request, env, params) => {
  const draft = await env.DB.prepare('SELECT * FROM drafts WHERE id = ?').bind(params.id).first();
  if (!draft) return errorResponse('Draft not found', 404);
  if (draft.user_id !== request.user.id && request.user.role_name !== 'admin') {
    return errorResponse('Cannot delete this draft', 403);
  }
  await env.DB.prepare('DELETE FROM drafts WHERE id = ?').bind(params.id).run();
  return jsonResponse({ success: true });
}));

// ==================== ORDERS ====================

router.get('/api/orders', requireAuth(async (request, env) => {
  const branchId = request.user.branch_id;
  const isAdmin = request.user.role_name === 'admin';
  const url = new URL(request.url);
  const status = url.searchParams.get('status');

  let query = `SELECT o.*, b.name as branch_name, u.full_name as user_name, c.name as customer_name 
    FROM orders o LEFT JOIN branches b ON o.branch_id = b.id 
    LEFT JOIN users u ON o.user_id = u.id LEFT JOIN customers c ON o.customer_id = c.id WHERE 1=1`;
  if (!isAdmin) query += ` AND o.branch_id = ?`;
  if (status) query += ` AND o.status = ?`;
  query += ` ORDER BY o.created_at DESC`;

  let stmt;
  if (!isAdmin && status) stmt = env.DB.prepare(query).bind(branchId, status);
  else if (!isAdmin) stmt = env.DB.prepare(query).bind(branchId);
  else if (status) stmt = env.DB.prepare(query).bind(status);
  else stmt = env.DB.prepare(query);

  const orders = await stmt.all();

  for (let order of orders.results) {
    const items = await env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(order.id).all();
    order.items = items.results;
  }

  return jsonResponse({ success: true, orders: orders.results });
}));

router.post('/api/orders', requirePermission('orders')(async (request, env) => {
  const { customer_id, customer_name, items, payment_method, expected_delivery_date, notes } = await request.json();
  const branchId = request.user.branch_id;
  const userId = request.user.id;

  if (!items || items.length === 0) return errorResponse('No items in order');

  const orderNumber = await generateOrderNumber(env, branchId);
  let subtotal = 0;
  items.forEach(item => subtotal += item.quantity * item.unit_price);

  const result = await env.DB.prepare(`INSERT INTO orders 
    (order_number, customer_id, customer_name, branch_id, user_id, subtotal, total_amount, 
    payment_method, expected_delivery_date, status, notes) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(orderNumber, customer_id || null, customer_name || null, branchId, userId, subtotal, subtotal, 
      payment_method || 'cash', expected_delivery_date || null, 'pending', notes || null).run();

  const orderId = result.meta.last_row_id;

  for (const item of items) {
    await env.DB.prepare(`INSERT INTO order_items (order_id, product_id, name, quantity, unit_price, total_price) 
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(orderId, item.product_id, item.name, item.quantity, item.unit_price, item.quantity * item.unit_price).run();

    // Reserve stock
    const stock = await env.DB.prepare('SELECT * FROM stock WHERE product_id = ? AND branch_id = ?')
      .bind(item.product_id, branchId).first();
    if (stock) {
      const newReserved = stock.reserved_quantity + item.quantity;
      await env.DB.prepare('UPDATE stock SET reserved_quantity = ? WHERE id = ?')
        .bind(newReserved, stock.id).run();
    }
  }

  await logAudit(env, userId, 'create', 'order', orderId, null, { order_number: orderNumber, total: subtotal }, request);
  return jsonResponse({ success: true, order_id: orderId, order_number: orderNumber });
}));

router.put('/api/orders/:id/status', requirePermission('orders')(async (request, env, params) => {
  const { status } = await request.json();
  const validStatuses = ['pending', 'paid', 'ready', 'delivered', 'cancelled'];
  if (!validStatuses.includes(status)) return errorResponse('Invalid status');

  const order = await env.DB.prepare('SELECT * FROM orders WHERE id = ?').bind(params.id).first();
  if (!order) return errorResponse('Order not found', 404);

  const oldStatus = order.status;
  await env.DB.prepare('UPDATE orders SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .bind(status, params.id).run();

  // Handle stock changes on status transitions
  if (status === 'delivered' && oldStatus !== 'delivered') {
    const items = await env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(params.id).all();
    for (const item of items.results) {
      const stock = await env.DB.prepare('SELECT * FROM stock WHERE product_id = ? AND branch_id = ?')
        .bind(item.product_id, order.branch_id).first();
      if (stock) {
        await env.DB.prepare('UPDATE stock SET quantity = ?, reserved_quantity = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
          .bind(stock.quantity - item.quantity, stock.reserved_quantity - item.quantity, stock.id).run();
      }
    }
  }

  if (status === 'cancelled' && oldStatus !== 'cancelled') {
    const items = await env.DB.prepare('SELECT * FROM order_items WHERE order_id = ?').bind(params.id).all();
    for (const item of items.results) {
      const stock = await env.DB.prepare('SELECT * FROM stock WHERE product_id = ? AND branch_id = ?')
        .bind(item.product_id, order.branch_id).first();
      if (stock) {
        await env.DB.prepare('UPDATE stock SET reserved_quantity = ? WHERE id = ?')
          .bind(stock.reserved_quantity - item.quantity, stock.id).run();
      }
    }
  }

  await logAudit(env, request.user.id, 'status_change', 'order', params.id, { status: oldStatus }, { status }, request);
  return jsonResponse({ success: true });
}));

// ==================== EXPENSES ====================

router.get('/api/expenses', requireAuth(async (request, env) => {
  const branchId = request.user.branch_id;
  const isAdmin = request.user.role_name === 'admin';
  const url = new URL(request.url);
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');

  let query = `SELECT e.*, b.name as branch_name, u.full_name as created_by_name 
    FROM expenses e LEFT JOIN branches b ON e.branch_id = b.id 
    LEFT JOIN users u ON e.created_by = u.id WHERE 1=1`;
  if (!isAdmin) query += ` AND e.branch_id = ?`;
  if (dateFrom && dateTo) query += ` AND DATE(e.date) BETWEEN ? AND ?`;
  query += ` ORDER BY e.date DESC`;

  let stmt;
  if (!isAdmin && dateFrom && dateTo) stmt = env.DB.prepare(query).bind(branchId, dateFrom, dateTo);
  else if (!isAdmin) stmt = env.DB.prepare(query).bind(branchId);
  else if (dateFrom && dateTo) stmt = env.DB.prepare(query).bind(dateFrom, dateTo);
  else stmt = env.DB.prepare(query);

  const expenses = await stmt.all();
  return jsonResponse({ success: true, expenses: expenses.results });
}));

router.post('/api/expenses', requirePermission('expenses')(async (request, env) => {
  const { category, amount, branch_id, description, date, receipt_number } = await request.json();
  const targetBranch = request.user.role_name === 'admin' ? branch_id : request.user.branch_id;

  const result = await env.DB.prepare(`INSERT INTO expenses (category, amount, branch_id, description, date, receipt_number, created_by) 
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(category, amount, targetBranch, description, date || new Date().toISOString().split('T')[0], receipt_number, request.user.id).run();

  await logAudit(env, request.user.id, 'create', 'expense', result.meta.last_row_id, null, { category, amount }, request);
  return jsonResponse({ success: true, id: result.meta.last_row_id });
}));

// ==================== EMPLOYEES ====================

router.get('/api/employees', requireAuth(async (request, env) => {
  const branchId = request.user.branch_id;
  const isAdmin = request.user.role_name === 'admin';

  let query = `SELECT e.*, b.name as branch_name FROM employees e LEFT JOIN branches b ON e.branch_id = b.id WHERE e.is_active = 1`;
  if (!isAdmin) query += ` AND e.branch_id = ?`;
  query += ` ORDER BY e.name`;

  const stmt = isAdmin ? env.DB.prepare(query) : env.DB.prepare(query).bind(branchId);
  const employees = await stmt.all();
  return jsonResponse({ success: true, employees: employees.results });
}));

router.post('/api/employees', requirePermission('employees')(async (request, env) => {
  const { name, role, branch_id, phone, email, salary, hire_date } = await request.json();
  const targetBranch = request.user.role_name === 'admin' ? branch_id : request.user.branch_id;

  const result = await env.DB.prepare(`INSERT INTO employees (name, role, branch_id, phone, email, salary, hire_date) 
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(name, role, targetBranch, phone, email, salary, hire_date).run();

  await logAudit(env, request.user.id, 'create', 'employee', result.meta.last_row_id, null, { name, role }, request);
  return jsonResponse({ success: true, id: result.meta.last_row_id });
}));

router.put('/api/employees/:id', requirePermission('employees')(async (request, env, params) => {
  const { name, role, branch_id, phone, email, salary, is_active } = await request.json();
  await env.DB.prepare(`UPDATE employees SET name = ?, role = ?, branch_id = ?, phone = ?, email = ?, salary = ?, is_active = ? WHERE id = ?`)
    .bind(name, role, branch_id, phone, email, salary, is_active, params.id).run();
  return jsonResponse({ success: true });
}));

// ==================== PAYROLL ====================

router.get('/api/payroll', requireAuth(async (request, env) => {
  const url = new URL(request.url);
  const month = url.searchParams.get('month');
  const year = url.searchParams.get('year');

  let query = `SELECT p.*, e.name as employee_name, e.role as employee_role, b.name as branch_name 
    FROM payroll p JOIN employees e ON p.employee_id = e.id 
    LEFT JOIN branches b ON e.branch_id = b.id WHERE 1=1`;
  if (month) query += ` AND p.month = ?`;
  if (year) query += ` AND p.year = ?`;
  query += ` ORDER BY p.created_at DESC`;

  let stmt = env.DB.prepare(query);
  if (month && year) stmt = env.DB.prepare(query).bind(month, year);
  else if (month) stmt = env.DB.prepare(query).bind(month);
  else if (year) stmt = env.DB.prepare(query).bind(year);

  const payroll = await stmt.all();
  return jsonResponse({ success: true, payroll: payroll.results });
}));

router.post('/api/payroll', requirePermission('payroll')(async (request, env) => {
  const { employee_id, month, year, base_salary, bonuses, deductions, payment_method, notes } = await request.json();
  const netSalary = base_salary + (bonuses || 0) - (deductions || 0);

  const result = await env.DB.prepare(`INSERT INTO payroll 
    (employee_id, month, year, base_salary, bonuses, deductions, net_salary, payment_method, status, notes, created_by) 
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(employee_id, month, year, base_salary, bonuses || 0, deductions || 0, netSalary, 
      payment_method || 'cash', 'pending', notes, request.user.id).run();

  return jsonResponse({ success: true, id: result.meta.last_row_id });
}));

router.put('/api/payroll/:id/pay', requirePermission('payroll')(async (request, env, params) => {
  const { payment_date, payment_method } = await request.json();
  await env.DB.prepare('UPDATE payroll SET status = ?, payment_date = ?, payment_method = ? WHERE id = ?')
    .bind('paid', payment_date || new Date().toISOString().split('T')[0], payment_method || 'cash', params.id).run();
  return jsonResponse({ success: true });
}));

// ==================== CUSTOMERS ====================

router.get('/api/customers', requireAuth(async (request, env) => {
  const customers = await env.DB.prepare('SELECT * FROM customers WHERE is_active = 1 ORDER BY name').all();
  return jsonResponse({ success: true, customers: customers.results });
}));

router.post('/api/customers', requireAuth(async (request, env) => {
  const { name, phone, email, address } = await request.json();
  const branchId = request.user.branch_id;
  const result = await env.DB.prepare('INSERT INTO customers (name, phone, email, address, branch_id) VALUES (?, ?, ?, ?, ?)')
    .bind(name, phone, email, address, branchId).run();
  return jsonResponse({ success: true, id: result.meta.last_row_id });
}));

router.put('/api/customers/:id', requireAuth(async (request, env, params) => {
  const { name, phone, email, address } = await request.json();
  await env.DB.prepare('UPDATE customers SET name = ?, phone = ?, email = ?, address = ? WHERE id = ?')
    .bind(name, phone, email, address, params.id).run();
  return jsonResponse({ success: true });
}));

// ==================== ANALYTICS & DASHBOARD ====================

router.get('/api/analytics/dashboard', requireAuth(async (request, env) => {
  const branchId = request.user.branch_id;
  const isAdmin = request.user.role_name === 'admin';

  const today = new Date().toISOString().split('T')[0];
  const thisMonth = today.substring(0, 7);

  // Today's sales
  let todaySalesQuery = `SELECT COALESCE(SUM(total_amount), 0) as total, COUNT(*) as count FROM sales WHERE DATE(created_at) = ? AND status = 'completed'`;
  if (!isAdmin) todaySalesQuery += ` AND branch_id = ?`;
  let todayStmt = isAdmin ? env.DB.prepare(todaySalesQuery).bind(today) : env.DB.prepare(todaySalesQuery).bind(today, branchId);
  const todaySales = await todayStmt.first();

  // This month's sales
  let monthSalesQuery = `SELECT COALESCE(SUM(total_amount), 0) as total FROM sales WHERE strftime('%Y-%m', created_at) = ? AND status = 'completed'`;
  if (!isAdmin) monthSalesQuery += ` AND branch_id = ?`;
  let monthStmt = isAdmin ? env.DB.prepare(monthSalesQuery).bind(thisMonth) : env.DB.prepare(monthSalesQuery).bind(thisMonth, branchId);
  const monthSales = await monthStmt.first();

  // Expenses this month
  let expensesQuery = `SELECT COALESCE(SUM(amount), 0) as total FROM expenses WHERE strftime('%Y-%m', date) = ?`;
  if (!isAdmin) expensesQuery += ` AND branch_id = ?`;
  let expensesStmt = isAdmin ? env.DB.prepare(expensesQuery).bind(thisMonth) : env.DB.prepare(expensesQuery).bind(thisMonth, branchId);
  const expenses = await expensesStmt.first();

  // Low stock alerts
  let lowStockQuery = `SELECT s.*, p.name as product_name, p.stock_threshold FROM stock s JOIN products p ON s.product_id = p.id WHERE s.quantity <= p.stock_threshold AND p.is_active = 1 AND p.is_deleted = 0`;
  if (!isAdmin) lowStockQuery += ` AND s.branch_id = ?`;
  let lowStockStmt = isAdmin ? env.DB.prepare(lowStockQuery) : env.DB.prepare(lowStockQuery).bind(branchId);
  const lowStock = await lowStockStmt.all();

  // Pending orders
  let ordersQuery = `SELECT COUNT(*) as count FROM orders WHERE status IN ('pending', 'paid', 'ready')`;
  if (!isAdmin) ordersQuery += ` AND branch_id = ?`;
  let ordersStmt = isAdmin ? env.DB.prepare(ordersQuery) : env.DB.prepare(ordersQuery).bind(branchId);
  const pendingOrders = await ordersStmt.first();

  // Daily sales chart (last 7 days)
  let chartQuery = `SELECT DATE(created_at) as date, COALESCE(SUM(total_amount), 0) as total, COUNT(*) as count 
    FROM sales WHERE created_at >= date('now', '-7 days') AND status = 'completed'`;
  if (!isAdmin) chartQuery += ` AND branch_id = ?`;
  chartQuery += ` GROUP BY DATE(created_at) ORDER BY date`;
  let chartStmt = isAdmin ? env.DB.prepare(chartQuery) : env.DB.prepare(chartQuery).bind(branchId);
  const salesChart = await chartStmt.all();

  // Payment method breakdown (this month)
  let paymentQuery = `SELECT payment_method, COALESCE(SUM(total_amount), 0) as total, COUNT(*) as count 
    FROM sales WHERE strftime('%Y-%m', created_at) = ? AND status = 'completed'`;
  if (!isAdmin) paymentQuery += ` AND branch_id = ?`;
  paymentQuery += ` GROUP BY payment_method`;
  let paymentStmt = isAdmin ? env.DB.prepare(paymentQuery).bind(thisMonth) : env.DB.prepare(paymentQuery).bind(thisMonth, branchId);
  const paymentBreakdown = await paymentStmt.all();

  // Top products this month
  let topProductsQuery = `SELECT si.name, SUM(si.quantity) as total_qty, SUM(si.total_price) as total_revenue 
    FROM sale_items si JOIN sales s ON si.sale_id = s.id WHERE strftime('%Y-%m', s.created_at) = ? AND s.status = 'completed' AND si.item_type = 'product'`;
  if (!isAdmin) topProductsQuery += ` AND s.branch_id = ?`;
  topProductsQuery += ` GROUP BY si.name ORDER BY total_revenue DESC LIMIT 5`;
  let topStmt = isAdmin ? env.DB.prepare(topProductsQuery).bind(thisMonth) : env.DB.prepare(topProductsQuery).bind(thisMonth, branchId);
  const topProducts = await topStmt.all();

  return jsonResponse({
    success: true,
    dashboard: {
      today_sales: { total: todaySales.total, count: todaySales.count },
      month_sales: { total: monthSales.total },
      month_expenses: { total: expenses.total },
      low_stock_count: lowStock.results.length,
      low_stock_items: lowStock.results,
      pending_orders: pendingOrders.count,
      sales_chart: salesChart.results,
      payment_breakdown: paymentBreakdown.results,
      top_products: topProducts.results
    }
  });
}));

// ==================== REPORTS / EXPORT ====================

router.get('/api/reports/sales', requirePermission('reports')(async (request, env) => {
  const url = new URL(request.url);
  const dateFrom = url.searchParams.get('date_from');
  const dateTo = url.searchParams.get('date_to');
  const format = url.searchParams.get('format') || 'json';

  let query = `SELECT s.invoice_number, s.created_at, s.customer_name, s.total_amount, s.payment_method, s.status, b.name as branch_name, u.full_name as user_name 
    FROM sales s LEFT JOIN branches b ON s.branch_id = b.id LEFT JOIN users u ON s.user_id = u.id WHERE s.status = 'completed'`;
  if (dateFrom && dateTo) query += ` AND DATE(s.created_at) BETWEEN ? AND ?`;
  query += ` ORDER BY s.created_at DESC`;

  let stmt;
  if (dateFrom && dateTo) stmt = env.DB.prepare(query).bind(dateFrom, dateTo);
  else stmt = env.DB.prepare(query);

  const sales = await stmt.all();

  if (format === 'csv') {
    let csv = 'Invoice,Date,Customer,Amount,Payment,Status,Branch,Cashier\n';
    for (const s of sales.results) {
      csv += `${s.invoice_number},${s.created_at},${s.customer_name || 'Walk-in'},${s.total_amount},${s.payment_method},${s.status},${s.branch_name},${s.user_name}\n`;
    }
    return new Response(csv, { headers: { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="sales-report.csv"' } });
  }

  return jsonResponse({ success: true, sales: sales.results });
}));

router.get('/api/reports/inventory', requirePermission('reports')(async (request, env) => {
  const inventory = await env.DB.prepare(`SELECT s.*, p.name as product_name, p.unit, p.price, p.stock_threshold, b.name as branch_name 
    FROM stock s JOIN products p ON s.product_id = p.id LEFT JOIN branches b ON s.branch_id = b.id WHERE p.is_deleted = 0 ORDER BY p.name`).all();
  return jsonResponse({ success: true, inventory: inventory.results });
}));

// ==================== NOTIFICATIONS ====================

router.get('/api/notifications', requireAuth(async (request, env) => {
  const branchId = request.user.branch_id;
  const isAdmin = request.user.role_name === 'admin';

  let query = `SELECT * FROM notifications WHERE 1=1`;
  if (!isAdmin) {
    query += ` AND (user_id = ? OR (user_id IS NULL AND branch_id = ?))`;
  }
  query += ` ORDER BY created_at DESC LIMIT 50`;

  const stmt = isAdmin ? env.DB.prepare(query) : env.DB.prepare(query).bind(request.user.id, branchId);
  const notifications = await stmt.all();
  return jsonResponse({ success: true, notifications: notifications.results });
}));

router.post('/api/notifications', requireAuth(async (request, env) => {
  const { type, title, message, data } = await request.json();
  const userId = request.user.id;
  const branchId = request.user.branch_id;

  if (!type || !title || !message) {
    return errorResponse('Type, title, and message are required');
  }

  const result = await env.DB.prepare(
    `INSERT INTO notifications (user_id, branch_id, type, title, message, data) VALUES (?, ?, ?, ?, ?, ?)`
  ).bind(userId, branchId, type, title, message, data ? JSON.stringify(data) : null).run();

  return jsonResponse({ success: true, id: result.meta.last_row_id });
}));

router.put('/api/notifications/:id/read', requireAuth(async (request, env, params) => {
  await env.DB.prepare('UPDATE notifications SET is_read = 1 WHERE id = ?').bind(params.id).run();
  return jsonResponse({ success: true });
}));

router.get('/api/notifications/unread-count', requireAuth(async (request, env) => {
  const branchId = request.user.branch_id;
  const isAdmin = request.user.role_name === 'admin';

  let query = `SELECT COUNT(*) as count FROM notifications WHERE is_read = 0`;
  if (!isAdmin) {
    query += ` AND (user_id = ? OR (user_id IS NULL AND branch_id = ?))`;
  }

  const stmt = isAdmin ? env.DB.prepare(query) : env.DB.prepare(query).bind(request.user.id, branchId);
  const count = await stmt.first();
  return jsonResponse({ success: true, count: count.count });
}));

// ==================== AUDIT LOGS ====================

router.get('/api/audit-logs', requirePermission('audit_logs')(async (request, env) => {
  const url = new URL(request.url);
  const limit = parseInt(url.searchParams.get('limit')) || 100;
  const offset = parseInt(url.searchParams.get('offset')) || 0;

  const logs = await env.DB.prepare(`SELECT al.*, u.full_name as user_name FROM audit_logs al LEFT JOIN users u ON al.user_id = u.id ORDER BY al.created_at DESC LIMIT ? OFFSET ?`)
    .bind(limit, offset).all();
  return jsonResponse({ success: true, logs: logs.results });
}));

// ==================== USERS & ROLES ====================

router.get('/api/users', requirePermission('users')(async (request, env) => {
  const users = await env.DB.prepare(`SELECT u.id, u.username, u.full_name, u.email, u.phone, u.is_active, u.last_login, u.created_at, 
    r.name as role_name, b.name as branch_name FROM users u JOIN roles r ON u.role_id = r.id LEFT JOIN branches b ON u.branch_id = b.id ORDER BY u.created_at DESC`).all();
  return jsonResponse({ success: true, users: users.results });
}));

router.post('/api/users', requirePermission('users')(async (request, env) => {
  const { username, full_name, email, password, role_id, branch_id, phone } = await request.json();

  // Validation
  if (!username || !full_name || !password || !role_id) {
    return errorResponse('Username, full name, password, and role are required');
  }

  if (password.length < 6) {
    return errorResponse('Password must be at least 6 characters');
  }

  const parsedRoleId = parseInt(role_id);
  if (isNaN(parsedRoleId) || parsedRoleId <= 0) {
    return errorResponse('Invalid role selected');
  }

  const passwordHash = await hashPassword(password);

  const result = await env.DB.prepare(`INSERT INTO users (username, full_name, email, password_hash, role_id, branch_id, phone) 
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .bind(username, full_name, email, passwordHash, parsedRoleId, branch_id || null, phone || null).run();

  await logAudit(env, request.user.id, 'create', 'user', result.meta.last_row_id, null, { username, full_name }, request);
  return jsonResponse({ success: true, id: result.meta.last_row_id });
}));

router.put('/api/users/:id', requirePermission('users')(async (request, env, params) => {
  const { full_name, email, role_id, branch_id, phone, is_active } = await request.json();

  if (!full_name || !role_id) {
    return errorResponse('Full name and role are required');
  }

  const parsedRoleId = parseInt(role_id);
  if (isNaN(parsedRoleId) || parsedRoleId <= 0) {
    return errorResponse('Invalid role selected');
  }

  await env.DB.prepare('UPDATE users SET full_name = ?, email = ?, role_id = ?, branch_id = ?, phone = ?, is_active = ? WHERE id = ?')
    .bind(full_name, email, parsedRoleId, branch_id || null, phone || null, is_active, params.id).run();
  return jsonResponse({ success: true });
}));

router.get('/api/roles', requireAuth(async (request, env) => {
  const roles = await env.DB.prepare('SELECT * FROM roles').all();
  return jsonResponse({ success: true, roles: roles.results });
}));

// ==================== MAIN HANDLER ====================

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization'
        }
      });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    // Serve static frontend files if needed (or use separate hosting)
    if (path === '/' || path === '/index.html') {
      return new Response('Frontend should be served separately or use Pages', { status: 200 });
    }

    return router.handle(request, env, ctx);
  }
};
