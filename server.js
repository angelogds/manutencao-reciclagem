// server.js — CRUD completo + Dashboard moderno + Layout
// Requer: express, express-ejs-layouts, sqlite3, multer, ejs, pdfkit

const express = require('express');
const expressLayouts = require('express-ejs-layouts');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const multer = require('multer');
const PDFDocument = require('pdfkit');

const app = express();
const PORT = process.env.PORT || 8080;
const DB_FILE = path.join(__dirname, 'database.sqlite');

// ========== MIDDLEWARE ==========
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));

// EJS + Layouts
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
app.use(expressLayouts);
app.set('layout', 'layout');

// ========== UPLOADS ==========
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const unique = Date.now() + "-" + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + "-" + unique + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// ========== BANCO ==========
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) return console.error(err);
  console.log(`SQLite conectado em ${DB_FILE}`);
});

db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS equipamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    codigo TEXT,
    local TEXT,
    descricao TEXT,
    imagem TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS ordens (
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
  )`);
});

// Helpers
const runAsync = (sql, p=[]) => new Promise((ok, err)=> db.run(sql,p,function(e){e?err(e):ok(this)}));
const allAsync = (sql, p=[]) => new Promise((ok, err)=> db.all(sql,p,(e,r)=>e?err(e):ok(r)));
const getAsync = (sql, p=[]) => new Promise((ok, err)=> db.get(sql,p,(e,r)=>e?err(e):ok(r)));

// ========== ROTAS ==========

// DASHBOARD COMPLETO
app.get('/', async (req, res) => {
  try {
    const totalEquip = await getAsync(`SELECT COUNT(*) c FROM equipamentos`);
    const totalAbertas = await getAsync(`SELECT COUNT(*) c FROM ordens WHERE status='aberta'`);
    const totalFechadas = await getAsync(`SELECT COUNT(*) c FROM ordens WHERE status='fechada'`);

    const ultimas = await allAsync(`
      SELECT o.id, o.tipo, e.nome AS equipamento_nome
      FROM ordens o
      LEFT JOIN equipamentos e ON e.id = o.equipamento_id
      ORDER BY o.aberta_em DESC
      LIMIT 5
    `);

    const tipos = await allAsync(`
      SELECT tipo, COUNT(*) c
      FROM ordens
      GROUP BY tipo
    `);

    res.render('admin/dashboard', {
      layout: 'layout',
      active: 'dashboard',

      totals: {
        equipamentos: totalEquip.c,
        abertas: totalAbertas.c,
        fechadas: totalFechadas.c
      },

      ultimas,

      tipos: {
        labels: tipos.map(t => t.tipo),
        valores: tipos.map(t => t.c)
      }
    });

  } catch (err) {
    console.error(err);
    res.send("Erro ao carregar dashboard.");
  }
});

// ========== EQUIPAMENTOS ==========

app.get('/equipamentos', async (req, res) => {
  try {
    const equipamentos = await allAsync(`SELECT * FROM equipamentos ORDER BY id DESC`);
    res.render('equipamentos', { layout: 'layout', active: 'equipamentos', equipamentos });
  } catch (e) {
    res.status(500).send("Erro ao listar equipamentos");
  }
});

app.get('/equipamentos/novo', (req, res) => {
  res.render('equipamentos_novo', {
    layout: 'layout',
    active: 'equipamentos',
    equipamento: null
  });
});

app.post('/equipamentos', upload.single('imagem'), async (req, res) => {
  try {
    const { nome, codigo, local, descricao } = req.body;
    const imagem = req.file ? "uploads/"+req.file.filename : null;

    await runAsync(
      `INSERT INTO equipamentos (nome, codigo, local, descricao, imagem)
       VALUES (?, ?, ?, ?, ?)`,
      [nome, codigo, local, descricao, imagem]
    );

    res.redirect('/equipamentos');
  } catch (err) {
    console.error(err);
    res.status(500).send("Erro ao criar equipamento");
  }
});

app.get('/equipamentos/:id/editar', async (req, res) => {
  try {
    const equipamento = await getAsync(`SELECT * FROM equipamentos WHERE id=?`, [req.params.id]);
    if (!equipamento) return res.send("Equipamento não encontrado");

    res.render('equipamentos_novo', {
      layout: 'layout',
      active: 'equipamentos',
      equipamento
    });
  } catch (err) {
    res.status(500).send("Erro");
  }
});

app.post('/equipamentos/:id', upload.single('imagem'), async (req, res) => {
  try {
    const { nome, codigo, local, descricao } = req.body;
    const eq = await getAsync(`SELECT * FROM equipamentos WHERE id=?`, [req.params.id]);

    let imagem = eq.imagem;
    if (req.file) {
      if (imagem) {
        const old = path.join(__dirname, 'public', imagem);
        if (fs.existsSync(old)) fs.unlinkSync(old);
      }
      imagem = "uploads/"+req.file.filename;
    }

    await runAsync(
      `UPDATE equipamentos SET nome=?, codigo=?, local=?, descricao=?, imagem=? WHERE id=?`,
      [nome, codigo, local, descricao, imagem, req.params.id]
    );

    res.redirect('/equipamentos');
  } catch (err) {
    res.status(500).send("Erro ao atualizar");
  }
});

app.post('/equipamentos/:id/delete', async (req, res) => {
  try {
    const eq = await getAsync(`SELECT * FROM equipamentos WHERE id=?`, [req.params.id]);

    if (eq.imagem) {
      const imgPath = path.join(__dirname, 'public', eq.imagem);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }

    await runAsync(`DELETE FROM equipamentos WHERE id=?`, [req.params.id]);
    res.redirect('/equipamentos');

  } catch (err) {
    res.status(500).send("Erro ao deletar");
  }
});

// ========== ORDENS (OS) ==========

app.get('/ordens', async (req, res) => {
  try {
    const ordens = await allAsync(`
      SELECT o.*, e.nome AS equipamento_nome
      FROM ordens o
      LEFT JOIN equipamentos e ON o.equipamento_id = e.id
      ORDER BY o.aberta_em DESC
    `);

    res.render('ordens', { layout: 'layout', active: 'ordens', ordens });
  } catch (err) {
    res.status(500).send("Erro ao listar ordens");
  }
});

app.get('/ordens/novo', async (req, res) => {
  const equipamentos = await allAsync(`SELECT id, nome FROM equipamentos ORDER BY nome`);
  res.render('abrir_os', { layout: 'layout', active: 'abrir_os', equipamentos });
});

app.post('/ordens', async (req, res) => {
  const { equipamento_id, solicitante, tipo, descricao } = req.body;

  await runAsync(
    `INSERT INTO ordens (equipamento_id, solicitante, tipo, descricao)
     VALUES (?, ?, ?, ?)`,
    [equipamento_id || null, solicitante, tipo, descricao]
  );

  res.redirect('/ordens');
});

app.get('/ordens/:id/fechar', async (req, res) => {
  const ordem = await getAsync(`SELECT * FROM ordens WHERE id=?`, [req.params.id]);
  res.render('ordens_fechar', { layout: 'layout', active: 'ordens', ordem });
});

app.post('/ordens/:id/fechar', async (req, res) => {
  await runAsync(
    `UPDATE ordens SET status='fechada', resultado=?, fechada_em=CURRENT_TIMESTAMP WHERE id=?`,
    [req.body.resultado, req.params.id]
  );

  res.redirect('/ordens');
});

// ========== PDF ==========
app.get('/solicitacao/pdf/:id', async (req, res) => {
  try {
    const ordem = await getAsync(`
      SELECT o.*, e.nome equipamento_nome, e.codigo equipamento_codigo
      FROM ordens o
      LEFT JOIN equipamentos e ON o.equipamento_id = e.id
      WHERE o.id=?`,
      [req.params.id]
    );

    if (!ordem) return res.send("OS não encontrada");

    const doc = new PDFDocument({ margin: 40 });
    res.setHeader("Content-Disposition", `attachment; filename=os_${ordem.id}.pdf`);
    res.setHeader("Content-Type", "application/pdf");
    doc.pipe(res);

    doc.fontSize(18).text("Ordem de Serviço", { align: "center" }).moveDown();
    doc.fontSize(12).text(`ID: ${ordem.id}`);
    doc.text(`Solicitante: ${ordem.solicitante}`);
    doc.text(`Tipo: ${ordem.tipo}`);
    doc.text(`Equipamento: ${ordem.equipamento_nome}`);
    doc.text(`Descrição: ${ordem.descricao}`).moveDown();
    doc.text(`Status: ${ordem.status}`);

    doc.end();
  } catch (err) {
    res.send("Erro ao gerar PDF");
  }
});

// ========== START ==========
app.listen(PORT, () => console.log(`Servidor ativo na porta ${PORT}`));
