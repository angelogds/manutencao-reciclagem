// server.js — Sistema manutenção + módulo correias (completo e corrigido)

// ---------------------- IMPORTS ----------------------
const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const session = require('express-session');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const PDFDocument = require('pdfkit');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { v4: uuidv4 } = require('uuid');
const QRCode = require('qrcode');

// ---------------------- CONFIG ----------------------
const app = express();
const PORT = process.env.PORT || 8080;
const DB_FILE = path.join(__dirname, 'database.sqlite');

// ---------------------- MIDDLEWARES GLOBAIS ----------------------
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.set('trust proxy', 1);

// ---------------------- SESSÃO ----------------------
app.use(session({
  secret: process.env.SESSION_SECRET || 'segredo-super-forte-123',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,
    maxAge: 24 * 60 * 60 * 1000
  }
}));

// disponibiliza session em views
app.use((req, res, next) => {
  res.locals.session = req.session;
  next();
});

// ---------------------- VIEW ENGINE / LAYOUT ----------------------
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// ---------------------- UPLOADS (MULTER) ----------------------
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination(req, file, cb) { cb(null, uploadsDir); },
  filename(req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// ---------------------- MAILER (opcional) ----------------------
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || '587', 10),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
  });
} else {
  console.log('Aviso: SMTP não configurado. Links de reset serão exibidos no console.');
}

// ---------------------- SEED (executa seed.js uma vez se presente) ----------------------
if (fs.existsSync('./seed.js')) {
  console.log('➡ Executando seed.js automaticamente...');
  try {
    require(path.join(__dirname, 'seed.js'));
    // remover após executar (tenta em 2s para garantir que seed terminou)
    setTimeout(() => {
      try {
        if (fs.existsSync('./seed.js')) fs.unlinkSync('./seed.js');
        console.log('✔ seed.js executado e removido.');
      } catch (e) {
        console.log('Erro removendo seed.js:', e);
      }
    }, 2000);
  } catch (e) {
    console.error('Erro ao executar seed.js:', e);
  }
}

// ---------------------- BANCO (SQLite) ----------------------
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) return console.error('Erro ao conectar no SQLite:', err);
  console.log('SQLite conectado em', DB_FILE);
});

// ---------- Criação das tabelas (tudo DENTRO do serialize) ----------
db.serialize(() => {

  // usuarios
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT UNIQUE,
      senha TEXT,
      nome TEXT,
      role TEXT DEFAULT 'funcionario'
    );
  `);

  // password tokens
  db.run(`
    CREATE TABLE IF NOT EXISTS password_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER,
      token TEXT,
      expires_at DATETIME
    );
  `);

  // equipamentos
  db.run(`
    CREATE TABLE IF NOT EXISTS equipamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      codigo TEXT,
      local TEXT,
      descricao TEXT,
      imagem TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // ordens
  db.run(`
    CREATE TABLE IF NOT EXISTS ordens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipamento_id INTEGER,
      solicitante TEXT,
      tipo TEXT,
      descricao TEXT,
      status TEXT DEFAULT 'aberta',
      aberta_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      fechada_em DATETIME,
      resultado TEXT,
      FOREIGN KEY (equipamento_id) REFERENCES equipamentos(id)
    );
  `);

  // correias (estoque)
  db.run(`
    CREATE TABLE IF NOT EXISTS correias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      modelo TEXT,
      medida TEXT,
      quantidade INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // correias_equipamentos
  db.run(`
    CREATE TABLE IF NOT EXISTS correias_equipamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipamento_id INTEGER,
      correia_id INTEGER,
      quantidade_usada INTEGER DEFAULT 1,
      FOREIGN KEY (equipamento_id) REFERENCES equipamentos(id),
      FOREIGN KEY (correia_id) REFERENCES correias(id)
    );
  `);

  // consumo_correias
  db.run(`
    CREATE TABLE IF NOT EXISTS consumo_correias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipamento_id INTEGER,
      correia_id INTEGER,
      quantidade INTEGER,
      data DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (equipamento_id) REFERENCES equipamentos(id),
      FOREIGN KEY (correia_id) REFERENCES correias(id)
    );
  `);

});

// ---------------------- HELPERS (Promises) ----------------------
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this);
    });
  });
}
function allAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) return reject(err);
      resolve(rows);
    });
  });
}
function getAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) return reject(err);
      resolve(row);
    });
  });
}

// Helper: registra consumo e atualiza estoque atomically
async function registrarConsumoCorreia(equipamento_id, correia_id, quantidade) {
  // diminuir estoque
  await runAsync(
    `UPDATE correias SET quantidade = quantidade - ? WHERE id = ?`,
    [quantidade, correia_id]
  );

  // registrar histórico
  await runAsync(
    `INSERT INTO consumo_correias (equipamento_id, correia_id, quantidade) VALUES (?, ?, ?)`,
    [equipamento_id, correia_id, quantidade]
  );
}

// ---------------------- MIDDLEWARES DE AUTENTICAÇÃO ----------------------
function authRequired(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}
function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.usuario) return res.redirect('/login');
    const userRole = req.session.role;
    if (userRole === 'admin') return next();
    if (Array.isArray(role)) {
      if (role.includes(userRole)) return next();
      return res.status(403).send('Acesso negado.');
    }
    if (userRole === role) return next();
    return res.status(403).send('Acesso negado.');
  };
}

// ---------------------- ROTAS ABERTAS (Proteção única) ----------------------
const rotasAbertas = ['/login','/forgot','/reset'];

// proteção global (após definições de static)
app.use((req, res, next) => {
  const url = req.path;
  if (url.startsWith('/css') || url.startsWith('/js') || url.startsWith('/img') || url.startsWith('/uploads')) return next();
  if (rotasAbertas.some(r => url.startsWith(r))) return next();
  if (!req.session.usuario) return res.redirect('/login');
  next();
});

// ---------------------- LOGIN / LOGOUT / RECUPERAÇÃO ----------------------
app.get('/login', (req, res) => res.render('login', { layout: false, error: null }));

app.post('/login', async (req, res) => {
  const { usuario, senha } = req.body;
  try {
    const user = await getAsync(`SELECT * FROM usuarios WHERE usuario = ?`, [usuario]);
    if (!user) return res.render('login', { layout: false, error: 'Usuário ou senha incorretos.' });
    const match = await bcrypt.compare(senha, user.senha);
    if (!match) return res.render('login', { layout: false, error: 'Usuário ou senha incorretos.' });
    req.session.usuario = user.usuario;
    req.session.userId = user.id;
    req.session.role = user.role;
    return res.redirect('/');
  } catch (err) {
    console.error(err);
    return res.render('login', { layout: false, error: 'Erro interno.' });
  }
});

app.get('/logout', (req, res) => { req.session.destroy(() => res.redirect('/login')); });

app.get('/forgot', (req, res) => res.render('forgot', { error: null, info: null }));

app.post('/forgot', async (req, res) => {
  const { usuario } = req.body;
  try {
    const user = await getAsync(`SELECT id, usuario FROM usuarios WHERE usuario = ?`, [usuario]);
    if (!user) return res.render('forgot', { error: 'Usuário não encontrado.', info: null });
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    await runAsync(`INSERT INTO password_tokens (usuario_id, token, expires_at) VALUES (?, ?, ?)`, [user.id, token, expiresAt]);
    const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
    const resetUrl = `${baseUrl}/reset/${token}`;
    if (transporter) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || 'no-reply@sistema.com',
        to: user.usuario,
        subject: 'Recuperar senha - Sistema de Manutenção',
        html: `<p>Você solicitou redefinição de senha.</p><p><a href="${resetUrl}">${resetUrl}</a></p>`
      });
      return res.render('forgot', { error: null, info: 'E-mail enviado! Verifique sua caixa de entrada.' });
    }
    console.log('Link de recuperação:', resetUrl);
    return res.render('forgot', { error: null, info: 'Link de recuperação gerado (verifique o console do servidor).' });
  } catch (err) {
    console.error(err);
    return res.render('forgot', { error: 'Erro interno.', info: null });
  }
});

app.get('/reset/:token', async (req, res) => res.render('reset', { token: req.params.token, error: null }));

app.post('/reset/:token', async (req, res) => {
  const { token } = req.params;
  const { senha } = req.body;
  try {
    const row = await getAsync(`SELECT usuario_id, expires_at FROM password_tokens WHERE token = ?`, [token]);
    if (!row) return res.render('reset', { token, error: 'Token inválido.' });
    if (new Date(row.expires_at) < new Date()) return res.render('reset', { token, error: 'Token expirado.' });
    const hashed = await bcrypt.hash(senha, 10);
    await runAsync(`UPDATE usuarios SET senha = ? WHERE id = ?`, [hashed, row.usuario_id]);
    await runAsync(`DELETE FROM password_tokens WHERE token = ?`, [token]);
    return res.send(`<h2>Senha atualizada com sucesso!</h2><a href="/login">Clique aqui para fazer login.</a>`);
  } catch (err) {
    console.error(err);
    return res.render('reset', { token, error: 'Erro interno.' });
  }
});

// ---------------------- USUÁRIOS (CRUD) — somente admin ----------------------
app.get('/users', authRequired, requireRole('admin'), async (req, res) => {
  try {
    const users = await allAsync(`SELECT id, usuario, nome, role FROM usuarios ORDER BY id DESC`);
    res.render('users', { users, active: 'users' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao listar usuários.');
  }
});

app.get('/users/new', authRequired, requireRole('admin'), (req, res) => res.render('users_new', { error: null, active: 'users' }));

app.post('/users/new', authRequired, requireRole('admin'), async (req, res) => {
  const { usuario, senha, nome, role } = req.body;
  try {
    if (!usuario || !senha) return res.render('users_new', { error: 'Usuário e senha são obrigatórios.' });
    const hashed = await bcrypt.hash(senha, 10);
    await runAsync(`INSERT INTO usuarios (usuario, senha, nome, role) VALUES (?, ?, ?, ?)`, [usuario, hashed, nome || usuario, role || 'funcionario']);
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    let msg = 'Erro ao criar usuário.';
    if (err.message && err.message.includes('UNIQUE')) msg = 'Este usuário já existe.';
    res.render('users_new', { error: msg });
  }
});

app.get('/users/:id/edit', authRequired, requireRole('admin'), async (req, res) => {
  try {
    const user = await getAsync(`SELECT id, usuario, nome, role FROM usuarios WHERE id = ?`, [req.params.id]);
    if (!user) return res.redirect('/users');
    res.render('users_edit', { user, error: null, active: 'users' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar usuário.');
  }
});

app.post('/users/:id/edit', authRequired, requireRole('admin'), async (req, res) => {
  const { nome, role } = req.body;
  try {
    await runAsync(`UPDATE usuarios SET nome = ?, role = ? WHERE id = ?`, [nome, role, req.params.id]);
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    res.send('Erro ao atualizar usuário.');
  }
});

app.post('/users/:id/delete', authRequired, requireRole('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);
    if (id === req.session.userId) return res.status(400).send('Você não pode excluir seu próprio usuário.');
    await runAsync(`DELETE FROM usuarios WHERE id = ?`, [id]);
    res.redirect('/users');
  } catch (err) {
    console.error(err);
    res.send('Erro ao excluir usuário.');
  }
});

// ---------------------- EQUIPAMENTOS (CRUD) ----------------------
app.get('/equipamentos', authRequired, async (req, res) => {
  try {
    const equipamentos = await allAsync(`SELECT * FROM equipamentos ORDER BY created_at DESC`);
    res.render('equipamentos', { equipamentos, active: 'equipamentos' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao listar equipamentos.');
  }
});

app.get('/equipamentos/novo', authRequired, (req, res) => res.render('equipamentos_novo', { equipamento: null, active: 'equipamentos' }));

app.post('/equipamentos', authRequired, upload.single('imagem'), async (req, res) => {
  try {
    const { nome, codigo, local, descricao } = req.body;
    const imagem = req.file ? path.join('uploads', req.file.filename) : null;
    await runAsync(`INSERT INTO equipamentos (nome, codigo, local, descricao, imagem) VALUES (?, ?, ?, ?, ?)`, [nome, codigo, local, descricao, imagem]);
    res.redirect('/equipamentos');
  } catch (err) {
    console.error(err);
    res.send('Erro ao criar equipamento.');
  }
});

app.get('/equipamentos/:id/editar', authRequired, async (req, res) => {
  try {
    const equipamento = await getAsync(`SELECT * FROM equipamentos WHERE id = ?`, [req.params.id]);
    if (!equipamento) return res.send('Equipamento não encontrado.');
    res.render('equipamentos_novo', { equipamento, active: 'equipamentos' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar formulário.');
  }
});

app.post('/equipamentos/:id', authRequired, upload.single('imagem'), async (req, res) => {
  try {
    const id = req.params.id;
    const { nome, codigo, local, descricao } = req.body;
    const equipamento = await getAsync(`SELECT * FROM equipamentos WHERE id = ?`, [id]);
    if (!equipamento) return res.send('Equipamento não encontrado.');
    let novaImagem = equipamento.imagem;
    if (req.file) {
      if (novaImagem) {
        const oldPath = path.join(__dirname, 'public', novaImagem);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      novaImagem = path.join('uploads', req.file.filename);
    }
    await runAsync(`UPDATE equipamentos SET nome=?, codigo=?, local=?, descricao=?, imagem=? WHERE id=?`, [nome, codigo, local, descricao, novaImagem, id]);
    res.redirect('/equipamentos');
  } catch (err) {
    console.error(err);
    res.send('Erro ao atualizar o equipamento.');
  }
});

app.post('/equipamentos/:id/delete', authRequired, async (req, res) => {
  try {
    const id = req.params.id;
    const equipamento = await getAsync(`SELECT * FROM equipamentos WHERE id = ?`, [id]);
    if (!equipamento) return res.send('Equipamento não encontrado.');
    if (equipamento.imagem) {
      const imgPath = path.join(__dirname, 'public', equipamento.imagem);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }
    await runAsync(`DELETE FROM equipamentos WHERE id = ?`, [id]);
    res.redirect('/equipamentos');
  } catch (err) {
    console.error(err);
    res.send('Erro ao deletar equipamento.');
  }
});

// ---------------------- CORREIAS (ROTAS DO MÓDULO) ----------------------

// Listar correias (estoque)
app.get('/correias', authRequired, async (req, res) => {
  try {
    const correias = await allAsync('SELECT * FROM correias ORDER BY nome');
    res.render('correias', { correias, active: 'correias' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao listar correias.');
  }
});

// Novo
app.get('/correias/novo', authRequired, (req, res) => res.render('correias_novo', { correia: null, active: 'correias', error: null }));

app.post('/correias/novo', authRequired, async (req, res) => {
  try {
    const { nome, modelo, medida, quantidade } = req.body;
    await runAsync(`INSERT INTO correias (nome, modelo, medida, quantidade) VALUES (?, ?, ?, ?)`, [nome, modelo, medida, parseInt(quantidade || 0, 10)]);
    res.redirect('/correias');
  } catch (err) {
    console.error(err);
    res.send('Erro ao criar correia.');
  }
});

// Editar
app.get('/correias/:id/editar', authRequired, async (req, res) => {
  try {
    const correia = await getAsync('SELECT * FROM correias WHERE id = ?', [req.params.id]);
    if (!correia) return res.redirect('/correias');
    res.render('correias_novo', { correia, active: 'correias', error: null });
  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar correia.');
  }
});

app.post('/correias/:id/editar', authRequired, async (req, res) => {
  try {
    const { nome, modelo, medida, quantidade } = req.body;
    await runAsync(`UPDATE correias SET nome=?, modelo=?, medida=?, quantidade=? WHERE id=?`, [nome, modelo, medida, parseInt(quantidade || 0, 10), req.params.id]);
    res.redirect('/correias');
  } catch (err) {
    console.error(err);
    res.send('Erro ao atualizar correia.');
  }
});

app.post('/correias/:id/delete', authRequired, async (req, res) => {
  try {
    await runAsync('DELETE FROM correias WHERE id = ?', [req.params.id]);
    res.redirect('/correias');
  } catch (err) {
    console.error(err);
    res.send('Erro ao deletar correia.');
  }
});

// Associação correias <-> equipamento (form)
app.get('/equipamentos/:id/correias', authRequired, async (req, res) => {
  try {
    const equipamento = await getAsync('SELECT * FROM equipamentos WHERE id = ?', [req.params.id]);
    if (!equipamento) return res.send('Equipamento não encontrado.');
    const correias = await allAsync('SELECT * FROM correias ORDER BY nome');
    const ligados = await allAsync('SELECT correia_id, quantidade_usada FROM correias_equipamentos WHERE equipamento_id = ?', [req.params.id]);
    const mapLigados = {};
    ligados.forEach(l => mapLigados[l.correia_id] = l.quantidade_usada);
    res.render('equipamento_correias', { equipamento, correias, mapLigados, active: 'equipamentos' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar associação de correias.');
  }
});

// Salvar associações
app.post('/equipamentos/:id/correias', authRequired, async (req, res) => {
  try {
    const equipamento_id = req.params.id;
    const correiaIds = Array.isArray(req.body.correia) ? req.body.correia : (req.body.correia ? [req.body.correia] : []);
    await runAsync('DELETE FROM correias_equipamentos WHERE equipamento_id = ?', [equipamento_id]);
    for (const cid of correiaIds) {
      const q = parseInt(req.body[`qtd_${cid}`] || 1, 10);
      await runAsync(`INSERT INTO correias_equipamentos (equipamento_id, correia_id, quantidade_usada) VALUES (?, ?, ?)`, [equipamento_id, cid, q]);
    }
    res.redirect('/equipamentos/' + equipamento_id);
  } catch (err) {
    console.error(err);
    res.send('Erro ao salvar associações.');
  }
});

// Baixa — abrir formulário
app.get('/equipamentos/:id/baixar', authRequired, async (req, res) => {
  try {
    const equipamento = await getAsync('SELECT * FROM equipamentos WHERE id = ?', [req.params.id]);
    if (!equipamento) return res.send('Equipamento não encontrado.');
    // pode pré-selecionar apenas correias associadas; por ora lista todas
    const correias = await allAsync('SELECT * FROM correias ORDER BY nome');
    res.render('equipamentos_baixar', { equipamento, correias, active: 'equipamentos' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao abrir formulário de baixa.');
  }
});

// Baixa — processar
app.post('/equipamentos/:id/baixar-correia', authRequired, async (req, res) => {
  try {
    const equipamento_id = req.params.id;
    const correia_id = parseInt(req.body.correia_id, 10);
    const quantidade = parseInt(req.body.quantidade, 10);
    if (!correia_id || !quantidade || quantidade <= 0) return res.send('Quantidade inválida.');
    const correia = await getAsync('SELECT * FROM correias WHERE id = ?', [correia_id]);
    if (!correia) return res.send('Correia não encontrada.');
    if (correia.quantidade < quantidade) return res.send('Estoque insuficiente. Atualize o estoque antes.');
    await registrarConsumoCorreia(equipamento_id, correia_id, quantidade);
    // redireciona para a página do equipamento
    res.redirect('/equipamentos/' + equipamento_id);
  } catch (err) {
    console.error(err);
    res.send('Erro ao debitar correia.');
  }
});

// Relatório mensal de consumo
app.get('/correias/relatorio', authRequired, async (req, res) => {
  try {
    const mes = req.query.mes || (new Date()).toISOString().slice(0,7);
    const rel = await allAsync(`
      SELECT 
        e.nome AS equipamento,
        c.nome AS correia,
        SUM(cc.quantidade) AS total
      FROM consumo_correias cc
      LEFT JOIN equipamentos e ON e.id = cc.equipamento_id
      LEFT JOIN correias c ON c.id = cc.correia_id
      WHERE strftime('%Y-%m', cc.data) = ?
      GROUP BY equipamento, correia
      ORDER BY equipamento, correia
    `, [mes]);
    res.render('relatorio_correias', { rel, mes, active: 'correias' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao gerar relatório.');
  }
});

// ---------------------- ORDENS (OS) ----------------------
app.get('/ordens', authRequired, async (req, res) => {
  try {
    const ordens = await allAsync(`
      SELECT o.*, e.nome AS equipamento_nome
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      ORDER BY o.aberta_em DESC
    `);
    res.render('ordens', { ordens, active: 'ordens' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao listar ordens.');
  }
});

app.get('/ordens/novo', authRequired, async (req, res) => {
  try {
    const equipamentos = await allAsync(`SELECT id, nome FROM equipamentos ORDER BY nome ASC`);
    res.render('abrir_os', { equipamentos, active: 'abrir_os' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao abrir formulário de OS.');
  }
});

app.post('/ordens', authRequired, async (req, res) => {
  try {
    const { equipamento_id, solicitante, tipo, descricao } = req.body;
    await runAsync(`INSERT INTO ordens (equipamento_id, solicitante, tipo, descricao, status) VALUES (?, ?, ?, ?, 'aberta')`, [equipamento_id || null, solicitante, tipo, descricao]);
    res.redirect('/ordens');
  } catch (err) {
    console.error(err);
    res.send('Erro ao criar OS.');
  }
});

app.get('/ordens/:id', authRequired, async (req, res) => {
  try {
    const ordem = await getAsync(`
      SELECT o.*, e.nome AS equipamento_nome, e.codigo AS equipamento_codigo
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      WHERE o.id = ?
    `, [req.params.id]);
    if (!ordem) return res.send('Ordem não encontrada.');
    res.render('ordens_fechar', { ordem, active: 'ordens' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar OS.');
  }
});

app.post('/ordens/:id/fechar', authRequired, async (req, res) => {
  try {
    await runAsync(`UPDATE ordens SET status='fechada', resultado=?, fechada_em=CURRENT_TIMESTAMP WHERE id=?`, [req.body.resultado, req.params.id]);
    res.redirect('/ordens');
  } catch (err) {
    console.error(err);
    res.send('Erro ao fechar OS.');
  }
});

// ---------------------- QR CODE DO EQUIPAMENTO ----------------------
app.get("/equipamentos/:id/qrcode", authRequired, async (req, res) => {
  try {
    const equipamento = await getAsync(`SELECT * FROM equipamentos WHERE id = ?`, [req.params.id]);
    if (!equipamento) return res.send("Equipamento não encontrado.");
    const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
    // O QR abre a página de baixa (/equipamentos/:id/baixar)
    const url = `${baseUrl}/equipamentos/${equipamento.id}/baixar`;
    const qr = await QRCode.toDataURL(url);
    res.render("equipamento_qr", { equipamento, qr, url, active: "equipamentos" });
  } catch (err) {
    console.error(err);
    res.send("Erro ao gerar QR Code.");
  }
});

// ---------------------- PDF da OS ----------------------
app.get('/solicitacao/pdf/:id', authRequired, async (req, res) => {
  try {
    const ordem = await getAsync(`
      SELECT o.*, e.nome AS equipamento_nome, e.codigo AS equipamento_codigo
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      WHERE o.id = ?
    `, [req.params.id]);
    if (!ordem) return res.send('Ordem não encontrada.');
    const doc = new PDFDocument({ margin: 40 });
    res.setHeader('Content-Disposition', `attachment; filename=OS_${ordem.id}.pdf`);
    res.setHeader('Content-Type', 'application/pdf');
    doc.pipe(res);
    doc.fontSize(20).text('Ordem de Serviço (OS)', { align: 'center' });
    doc.moveDown();
    doc.fontSize(12).text(`ID da OS: ${ordem.id}`);
    doc.text(`Solicitante: ${ordem.solicitante || '-'}`);
    doc.text(`Tipo: ${ordem.tipo || '-'}`);
    doc.text(`Equipamento: ${ordem.equipamento_nome || '-'} (${ordem.equipamento_codigo || '-'})`);
    doc.moveDown();
    doc.text('Descrição do problema:');
    doc.fontSize(11).text(ordem.descricao || '-', { indent: 10 });
    doc.moveDown();
    doc.fontSize(12).text(`Status: ${ordem.status}`);
    if (ordem.status === 'fechada') {
      doc.text(`Fechada em: ${ordem.fechada_em}`);
      doc.text(`Resultado: ${ordem.resultado || '-'}`);
    }
    doc.moveDown(2);
    doc.text('Assinatura: ____________________________');
    doc.end();
  } catch (err) {
    console.error(err);
    res.send('Erro ao gerar PDF.');
  }
});

// ---------------------- DASHBOARD ----------------------
app.get('/', authRequired, async (req, res) => {
  try {
    const totalEquip = await getAsync(`SELECT COUNT(*) AS c FROM equipamentos`);
    const totalAbertas = await getAsync(`SELECT COUNT(*) AS c FROM ordens WHERE status='aberta'`);
    const totalFechadas = await getAsync(`SELECT COUNT(*) AS c FROM ordens WHERE status='fechada'`);
    const tipos = await allAsync(`SELECT tipo, COUNT(*) AS total FROM ordens GROUP BY tipo`);
    const porMes = await allAsync(`
      SELECT strftime('%Y-%m', aberta_em) AS mes, COUNT(*) AS total
      FROM ordens GROUP BY mes ORDER BY mes ASC
    `);
    const ultimas = await allAsync(`
      SELECT o.*, e.nome AS equipamento_nome
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      ORDER BY o.aberta_em DESC LIMIT 6
    `);
    res.render('admin/dashboard', {
      active: 'dashboard',
      totais: {
        equipamentos: totalEquip?.c || 0,
        abertas: totalAbertas?.c || 0,
        fechadas: totalFechadas?.c || 0
      },
      tipos, porMes, ultimas
    });
  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar dashboard.');
  }
});

// ---------------------- API JSON (opcionais) ----------------------
app.get('/api/equipamentos', async (req, res) => {
  try {
    const equipamentos = await allAsync('SELECT * FROM equipamentos ORDER BY created_at DESC');
    res.json(equipamentos);
  } catch (err) {
    res.status(500).json({ error: 'Erro' });
  }
});
app.get('/api/ordens', async (req, res) => {
  try {
    const ordens = await allAsync('SELECT * FROM ordens ORDER BY aberta_em DESC');
    res.json(ordens);
  } catch (err) {
    res.status(500).json({ error: 'Erro' });
  }
});

// ---------------------- START ----------------------
app.listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
  console.log(`SQLite conectado em ${DB_FILE}`);
});
