//-----------------------------------------------------
// EXECUTAR SEED AUTOMATICAMENTE (APENAS 1 VEZ)
//-----------------------------------------------------
const fsExtra = require("fs");

if (fsExtra.existsSync("./seed.js")) {
  console.log("➡ Executando seed.js automaticamente...");

  require("./seed.js");

  // remover após executar
  setTimeout(() => {
    try {
      fsExtra.unlinkSync("./seed.js");
      console.log("✔ seed.js executado e removido.");
    } catch (e) {
      console.log("Erro removendo seed.js:", e);
    }
  }, 2000);
}
// server.js — BLOCO 1/9
// Cabeçalho, imports, configuração inicial, sessão, layout e uploads

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

// ---------------------- APP & PORT ----------------------
const app = express();
const PORT = process.env.PORT || 8080;
const DB_FILE = path.join(__dirname, 'database.sqlite');

// ---------------------- MIDDLEWARES GLOBAIS ----------------------
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// Trust proxy (Railway / proxies)
app.set('trust proxy', 1);

// ---------------------- SESSÃO ----------------------
app.use(session({
  secret: process.env.SESSION_SECRET || 'segredo-super-forte-123',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: false,           // em produção com HTTPS set true
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
  destination(req, file, cb) {
    cb(null, uploadsDir);
  },
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

// ---------------------- (FIM BLOCO 1) ----------------------
// ---------------------- BLOCO 2/9 ----------------------
// Banco de dados + criação de tabelas + helpers

// ---------- Conexão SQLite ----------
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) return console.error('Erro ao conectar no SQLite:', err);
  console.log('SQLite conectado em', DB_FILE);
});

// ---------- Criação das tabelas ----------
db.serialize(() => {

  // Tabela de usuários (login + roles)
  db.run(`
    CREATE TABLE IF NOT EXISTS usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario TEXT UNIQUE,
      senha TEXT,
      nome TEXT,
      role TEXT DEFAULT 'funcionario'   -- admin | funcionario | operador
    );
  `);

  // Tabela de recuperação de senha
  db.run(`
    CREATE TABLE IF NOT EXISTS password_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      usuario_id INTEGER,
      token TEXT,
      expires_at DATETIME
    );
  `);

  // Tabela de equipamentos
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

  // Tabela de ordens de serviço
  db.run(`
    CREATE TABLE IF NOT EXISTS ordens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipamento_id INTEGER,
      solicitante TEXT,
      tipo TEXT,
      descricao TEXT,
      status TEXT DEFAULT 'aberta',           -- aberta / fechada
      aberta_em DATETIME DEFAULT CURRENT_TIMESTAMP,
      fechada_em DATETIME,
      resultado TEXT,
      FOREIGN KEY (equipamento_id) REFERENCES equipamentos(id)
    );
  `);

});

// ---------- Helpers Promises ----------
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

// ---------------------- (FIM BLOCO 2) ----------------------
// ---------------------- BLOCO 3/9 ----------------------
// LOGIN, LOGOUT, RECUPERAÇÃO DE SENHA (FORGOT & RESET)

// ---------- Middlewares de autenticação ----------
function authRequired(req, res, next) {
  if (!req.session.usuario) return res.redirect('/login');
  next();
}

function requireRole(role) {
  return (req, res, next) => {
    if (!req.session.usuario) return res.redirect('/login');

    const userRole = req.session.role;

    // Admin sempre pode tudo
    if (userRole === 'admin') return next();

    // Se roles múltiplas
    if (Array.isArray(role)) {
      if (role.includes(userRole)) return next();
      return res.status(403).send('Acesso negado.');
    }

    // Role único
    if (userRole === role) return next();

    return res.status(403).send('Acesso negado.');
  };
}

// ---------------------- LOGIN ----------------------
app.get('/login', (req, res) => {
  res.render('login', { layout: false, error: null });
});

app.post('/login', async (req, res) => {
  const { usuario, senha } = req.body;

  try {
    const user = await getAsync(
      `SELECT * FROM usuarios WHERE usuario = ?`,
      [usuario]
    );

    if (!user)
      return res.render('login', { layout: false, error: 'Usuário ou senha incorretos.' });

    const match = await bcrypt.compare(senha, user.senha);
    if (!match)
      return res.render('login', { layout: false, error: 'Usuário ou senha incorretos.' });

    // Salva sessão
    req.session.usuario = user.usuario;
    req.session.userId = user.id;
    req.session.role = user.role;

    return res.redirect('/');
  } catch (err) {
    console.error(err);
    return res.render('login', { layout: false, error: 'Erro interno.' });
  }
});

// ---------------------- LOGOUT ----------------------
app.get('/logout', (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

// ---------------------- FORGOT PASSWORD ----------------------
app.get('/forgot', (req, res) => {
  res.render('forgot', { error: null, info: null });
});

app.post('/forgot', async (req, res) => {
  const { usuario } = req.body;

  try {
    const user = await getAsync(`SELECT id, usuario FROM usuarios WHERE usuario = ?`, [usuario]);

    if (!user)
      return res.render('forgot', { error: 'Usuário não encontrado.', info: null });

    // cria token único
    const token = uuidv4();
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString(); // 1 hora

    await runAsync(
      `INSERT INTO password_tokens (usuario_id, token, expires_at) VALUES (?, ?, ?)`,
      [user.id, token, expiresAt]
    );

    // URL de reset
    const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
    const resetUrl = `${baseUrl}/reset/${token}`;

    // se SMTP estiver configurado → envia email
    if (transporter) {
      await transporter.sendMail({
        from: process.env.SMTP_FROM || 'no-reply@sistema.com',
        to: user.usuario,
        subject: 'Recuperar senha - Sistema de Manutenção',
        html: `
          <p>Você solicitou redefinição de senha.</p>
          <p>Clique no link abaixo:</p>
          <a href="${resetUrl}">${resetUrl}</a>
        `
      });

      return res.render('forgot', {
        error: null,
        info: 'E-mail enviado! Verifique sua caixa de entrada.'
      });
    }

    // Sem SMTP → mostra no LOG do Railway
    console.log('Link de recuperação:', resetUrl);

    return res.render('forgot', {
      error: null,
      info: 'Link de recuperação gerado (verifique o console do servidor).'
    });
  } catch (err) {
    console.error(err);
    return res.render('forgot', { error: 'Erro interno.', info: null });
  }
});

// ---------------------- RESET PASSWORD ----------------------
app.get('/reset/:token', async (req, res) => {
  res.render('reset', { token: req.params.token, error: null });
});

app.post('/reset/:token', async (req, res) => {
  const { token } = req.params;
  const { senha } = req.body;

  try {
    const row = await getAsync(
      `SELECT usuario_id, expires_at FROM password_tokens WHERE token = ?`,
      [token]
    );

    if (!row)
      return res.render('reset', { token, error: 'Token inválido.' });

    // token expirado
    if (new Date(row.expires_at) < new Date())
      return res.render('reset', { token, error: 'Token expirado.' });

    // atualizar senha
    const hashed = await bcrypt.hash(senha, 10);
    await runAsync(`UPDATE usuarios SET senha = ? WHERE id = ?`, [hashed, row.usuario_id]);

    // remover token
    await runAsync(`DELETE FROM password_tokens WHERE token = ?`, [token]);

    return res.send(`
      <h2>Senha atualizada com sucesso!</h2>
      <a href="/login">Clique aqui para fazer login.</a>
    `);
  } catch (err) {
    console.error(err);
    return res.render('reset', { token, error: 'Erro interno.' });
  }
});

// ---------------------- (FIM BLOCO 3) ----------------------
// ---------------------- BLOCO 4/9 ----------------------
// CRUD de Usuários — somente ADMIN pode acessar

// LISTAR USUÁRIOS
app.get('/users', authRequired, requireRole('admin'), async (req, res) => {
  try {
    const users = await allAsync(`
      SELECT id, usuario, nome, role
      FROM usuarios
      ORDER BY id DESC
    `);
    res.render('users', { users, active: 'users' });
  } catch (err) {
    console.error(err);
    res.send('Erro ao listar usuários.');
  }
});

// FORM NOVO USUÁRIO
app.get('/users/new', authRequired, requireRole('admin'), (req, res) => {
  res.render('users_new', { error: null, active: 'users' });
});

// CRIAR USUÁRIO
app.post('/users/new', authRequired, requireRole('admin'), async (req, res) => {
  const { usuario, senha, nome, role } = req.body;

  try {
    if (!usuario || !senha)
      return res.render('users_new', { error: 'Usuário e senha são obrigatórios.' });

    const hashed = await bcrypt.hash(senha, 10);

    await runAsync(
      `INSERT INTO usuarios (usuario, senha, nome, role) VALUES (?, ?, ?, ?)`,
      [usuario, hashed, nome || usuario, role || 'funcionario']
    );

    res.redirect('/users');

  } catch (err) {
    console.error(err);
    let msg = 'Erro ao criar usuário.';

    if (err.message && err.message.includes('UNIQUE'))
      msg = 'Este usuário já existe.';

    res.render('users_new', { error: msg });
  }
});

// FORM EDITAR USUÁRIO
app.get('/users/:id/edit', authRequired, requireRole('admin'), async (req, res) => {
  try {
    const user = await getAsync(
      `SELECT id, usuario, nome, role FROM usuarios WHERE id = ?`,
      [req.params.id]
    );

    if (!user) return res.redirect('/users');

    res.render('users_edit', { user, error: null, active: 'users' });

  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar usuário.');
  }
});

// ATUALIZAR USUÁRIO
app.post('/users/:id/edit', authRequired, requireRole('admin'), async (req, res) => {
  const { nome, role } = req.body;

  try {
    await runAsync(
      `UPDATE usuarios SET nome = ?, role = ? WHERE id = ?`,
      [nome, role, req.params.id]
    );

    res.redirect('/users');

  } catch (err) {
    console.error(err);
    res.send('Erro ao atualizar usuário.');
  }
});

// EXCLUIR USUÁRIO
app.post('/users/:id/delete', authRequired, requireRole('admin'), async (req, res) => {
  try {
    const id = parseInt(req.params.id);

    // impede excluir a si mesmo
    if (id === req.session.userId)
      return res.status(400).send('Você não pode excluir seu próprio usuário.');

    await runAsync(
      `DELETE FROM usuarios WHERE id = ?`,
      [id]
    );

    res.redirect('/users');
  } catch (err) {
    console.error(err);
    res.send('Erro ao excluir usuário.');
  }
});

// ---------------------- (FIM BLOCO 4) ----------------------
// ---------------------- BLOCO 5/9 ----------------------
// PROTEÇÃO GLOBAL DAS ROTAS INTERNAS

// Rotas que NÃO precisam estar logadas
const rotasAbertas = [
  '/login',
  '/forgot',
  '/reset',
];

// Proteção global para todas as outras rotas
app.use((req, res, next) => {
  const url = req.path;

  // permitir arquivos estáticos
  if (url.startsWith('/css') || url.startsWith('/js') || url.startsWith('/img') || url.startsWith('/uploads')) {
    return next();
  }

  // permitir rotas abertas
  if (rotasAbertas.some(r => url.startsWith(r))) {
    return next();
  }

  // se não estiver logado, redireciona
  if (!req.session.usuario) {
    return res.redirect('/login');
  }

  next();
});

// ---------------------- (FIM BLOCO 5) ----------------------
// ---------------------- BLOCO 6/9 ----------------------
// CRUD DE EQUIPAMENTOS — protegido por login

// LISTAR EQUIPAMENTOS
app.get('/equipamentos', authRequired, async (req, res) => {
  try {
    const equipamentos = await allAsync(
      `SELECT * FROM equipamentos ORDER BY created_at DESC`
    );

    res.render('equipamentos', {
      equipamentos,
      active: 'equipamentos'
    });

  } catch (err) {
    console.error(err);
    res.send('Erro ao listar equipamentos.');
  }
});

// FORMULÁRIO — NOVO EQUIPAMENTO
app.get('/equipamentos/novo', authRequired, async (req, res) => {
  res.render('equipamentos_novo', {
    equipamento: null,
    active: 'equipamentos'
  });
});

// CRIAR EQUIPAMENTO
app.post('/equipamentos', authRequired, upload.single('imagem'), async (req, res) => {
  try {
    const { nome, codigo, local, descricao } = req.body;

    const imagem = req.file ? path.join('uploads', req.file.filename) : null;

    await runAsync(
      `INSERT INTO equipamentos (nome, codigo, local, descricao, imagem)
       VALUES (?, ?, ?, ?, ?)`,
      [nome, codigo, local, descricao, imagem]
    );

    res.redirect('/equipamentos');

  } catch (err) {
    console.error(err);
    res.send('Erro ao criar equipamento.');
  }
});

// FORMULÁRIO — EDITAR EQUIPAMENTO
app.get('/equipamentos/:id/editar', authRequired, async (req, res) => {
  try {
    const equipamento = await getAsync(
      `SELECT * FROM equipamentos WHERE id = ?`,
      [req.params.id]
    );

    if (!equipamento) return res.send('Equipamento não encontrado.');

    res.render('equipamentos_novo', {
      equipamento,
      active: 'equipamentos'
    });

  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar formulário.');
  }
});

// ATUALIZAR EQUIPAMENTO
app.post('/equipamentos/:id', authRequired, upload.single('imagem'), async (req, res) => {
  try {
    const id = req.params.id;
    const { nome, codigo, local, descricao } = req.body;

    const equipamento = await getAsync(
      `SELECT * FROM equipamentos WHERE id = ?`,
      [id]
    );

    if (!equipamento) return res.send('Equipamento não encontrado.');

    let novaImagem = equipamento.imagem;

    // Se enviou uma nova imagem → troca
    if (req.file) {
      // apagar imagem antiga
      if (novaImagem) {
        const oldPath = path.join(__dirname, 'public', novaImagem);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }

      novaImagem = path.join('uploads', req.file.filename);
    }

    await runAsync(
      `UPDATE equipamentos
       SET nome=?, codigo=?, local=?, descricao=?, imagem=?
       WHERE id=?`,
      [nome, codigo, local, descricao, novaImagem, id]
    );

    res.redirect('/equipamentos');

  } catch (err) {
    console.error(err);
    res.send('Erro ao atualizar o equipamento.');
  }
});

// DELETAR EQUIPAMENTO
app.post('/equipamentos/:id/delete', authRequired, async (req, res) => {
  try {
    const id = req.params.id;

    const equipamento = await getAsync(
      `SELECT * FROM equipamentos WHERE id = ?`,
      [id]
    );

    if (!equipamento) return res.send('Equipamento não encontrado.');

    // apagar imagem
    if (equipamento.imagem) {
      const imgPath = path.join(__dirname, 'public', equipamento.imagem);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }

    await runAsync(
      `DELETE FROM equipamentos WHERE id = ?`,
      [id]
    );

    res.redirect('/equipamentos');

  } catch (err) {
    console.error(err);
    res.send('Erro ao deletar equipamento.');
  }
});

// ---------------------- (FIM BLOCO 6) ----------------------
// ---------------------- BLOCO 7/9 ----------------------
// CRUD DE ORDENS DE SERVIÇO (OS)
// ====================================================================
// BLOCO 7 — ORDENS DE SERVIÇO (OS) + QR CODE do Equipamento
// ====================================================================

const QRCode = require("qrcode");

// ---------------------------------------------
// LISTAR ORDENS
// ---------------------------------------------
app.get('/ordens', authRequired, async (req, res) => {
  try {
    const ordens = await allAsync(`
      SELECT o.*, e.nome AS equipamento_nome
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      ORDER BY o.aberta_em DESC
    `);

    res.render('ordens', {
      ordens,
      active: 'ordens'
    });

  } catch (err) {
    console.error(err);
    res.send('Erro ao listar ordens.');
  }
});

// ---------------------------------------------
// FORM — ABRIR OS
// ---------------------------------------------
app.get('/ordens/novo', authRequired, async (req, res) => {
  try {
    const equipamentos = await allAsync(
      `SELECT id, nome FROM equipamentos ORDER BY nome ASC`
    );

    res.render('abrir_os', {
      equipamentos,
      active: 'abrir_os'
    });

  } catch (err) {
    console.error(err);
    res.send('Erro ao abrir formulário de OS.');
  }
});

// ---------------------------------------------
// CRIAR OS
// ---------------------------------------------
app.post('/ordens', authRequired, async (req, res) => {
  try {
    const { equipamento_id, solicitante, tipo, descricao } = req.body;

    await runAsync(
      `INSERT INTO ordens (equipamento_id, solicitante, tipo, descricao, status)
       VALUES (?, ?, ?, ?, 'aberta')`,
      [equipamento_id || null, solicitante, tipo, descricao]
    );

    res.redirect('/ordens');

  } catch (err) {
    console.error(err);
    res.send('Erro ao criar OS.');
  }
});

// ---------------------------------------------
// VER OS / FORM PARA FECHAR
// ---------------------------------------------
app.get('/ordens/:id', authRequired, async (req, res) => {
  try {
    const ordem = await getAsync(`
      SELECT o.*, e.nome AS equipamento_nome, e.codigo AS equipamento_codigo
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      WHERE o.id = ?
    `, [req.params.id]);

    if (!ordem) return res.send('Ordem não encontrada.');

    res.render('ordens_fechar', {
      ordem,
      active: 'ordens'
    });

  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar OS.');
  }
});

// ---------------------------------------------
// FECHAR OS
// ---------------------------------------------
app.post('/ordens/:id/fechar', authRequired, async (req, res) => {
  try {
    await runAsync(
      `UPDATE ordens
       SET status='fechada', resultado=?, fechada_em=CURRENT_TIMESTAMP
       WHERE id=?`,
      [req.body.resultado, req.params.id]
    );

    res.redirect('/ordens');

  } catch (err) {
    console.error(err);
    res.send('Erro ao fechar OS.');
  }
});



// ====================================================================
// QR CODE DO EQUIPAMENTO (Abre o menu mobile correta)
// ====================================================================
app.get("/equipamentos/:id/qrcode", authRequired, async (req, res) => {
  try {
    const equipamento = await getAsync(
      `SELECT * FROM equipamentos WHERE id = ?`,
      [req.params.id]
    );

    if (!equipamento) return res.send("Equipamento não encontrado.");

    // URL que o QR Code deve abrir → MENU MOBILE
    const baseUrl = process.env.BASE_URL || `https://${req.headers.host}`;
    const url = `${baseUrl}/equipamento/${equipamento.id}/menu`;

    // Gera QR Code base64
    const qr = await QRCode.toDataURL(url);

    res.render("equipamento_qr", {
      equipamento,
      qr,
      url,
      active: "equipamentos",
    });

  } catch (err) {
    console.error(err);
    res.send("Erro ao gerar QR Code.");
  }
});



// ====================================================================
// GERAR PDF DA OS (com dados completos)
// ====================================================================
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


// ---------------------- (FIM BLOCO 7) ----------------------
// ---------------------- BLOCO 8/9 ----------------------
// DASHBOARD COMPLETO (estatísticas + gráficos)

// HOME / DASHBOARD
app.get('/', authRequired, async (req, res) => {
  try {

    // --- Totais gerais ---
    const totalEquip = await getAsync(`SELECT COUNT(*) AS c FROM equipamentos`);
    const totalAbertas = await getAsync(`SELECT COUNT(*) AS c FROM ordens WHERE status='aberta'`);
    const totalFechadas = await getAsync(`SELECT COUNT(*) AS c FROM ordens WHERE status='fechada'`);

    // --- OS por tipo (para gráfico pizza) ---
    const tipos = await allAsync(`
      SELECT tipo, COUNT(*) AS total
      FROM ordens
      GROUP BY tipo
    `);

    // --- OS por mês (gráfico barra) ---
    const porMes = await allAsync(`
      SELECT strftime('%Y-%m', aberta_em) AS mes,
             COUNT(*) AS total
      FROM ordens
      GROUP BY mes
      ORDER BY mes ASC
    `);

    // --- Últimas ordens ---
    const ultimas = await allAsync(`
      SELECT o.*, e.nome AS equipamento_nome
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      ORDER BY o.aberta_em DESC
      LIMIT 6
    `);

    res.render('admin/dashboard', {
      active: 'dashboard',
      totais: {
        equipamentos: totalEquip?.c || 0,
        abertas: totalAbertas?.c || 0,
        fechadas: totalFechadas?.c || 0
      },
      tipos,
      porMes,
      ultimas
    });

  } catch (err) {
    console.error(err);
    res.send('Erro ao carregar dashboard.');
  }
});

// ---------------------- (FIM BLOCO 8) ----------------------
// ---------------------- BLOCO 9/9 ----------------------
// START DO SERVIDOR

app.listen(PORT, () => {
  console.log(`Servidor ativo na porta ${PORT}`);
  console.log(`SQLite conectado em ${DB_FILE}`);
});

// ---------------------- FIM DO ARQUIVO ----------------------
