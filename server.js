// server.js — CRUD completo para "manutencao-reciclagem"
// Requer: express, sqlite3, multer, ejs, pdfkit
const express = require('express');
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
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ========== MULTER (uploads) ==========
const uploadsDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir, { recursive: true });

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, uploadsDir);
  },
  filename: function (req, file, cb) {
    const unique = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname);
    cb(null, file.fieldname + '-' + unique + ext);
  }
});
const upload = multer({ storage });

// ========== DATABASE (SQLite) ==========
const db = new sqlite3.Database(DB_FILE, (err) => {
  if (err) return console.error('SQLite error:', err);
  console.log('Connected to SQLite at', DB_FILE);
});

// Create tables if not exist
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS equipamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL,
    codigo TEXT,
    local TEXT,
    descricao TEXT,
    imagem TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );`);

  db.run(`CREATE TABLE IF NOT EXISTS ordens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    equipamento_id INTEGER,
    solicitante TEXT,
    tipo TEXT,
    descricao TEXT,
    status TEXT DEFAULT 'aberta', -- aberta | fechada
    aberta_em DATETIME DEFAULT CURRENT_TIMESTAMP,
    fechada_em DATETIME,
    resultado TEXT,
    FOREIGN KEY (equipamento_id) REFERENCES equipamentos(id)
  );`);
});

// Helper: run DB with Promise
function runAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) return reject(err);
      resolve(this); // this.lastID, this.changes
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

// ========== ROUTES ==========

// Home / Dashboard
app.get('/', async (req, res) => {
  try {
    const totalEquip = await getAsync('SELECT COUNT(*) AS c FROM equipamentos');
    const totalOrdens = await getAsync('SELECT COUNT(*) AS c FROM ordens');
    res.render('admin/dashboard', {
      totals: { equipamentos: totalEquip ? totalEquip.c : 0, ordens: totalOrdens ? totalOrdens.c : 0 }
    });
  } catch (err) {
    console.error(err);
    res.render('admin/dashboard', { totals: { equipamentos: 0, ordens: 0 } });
  }
});

// ---------------- Equipamentos CRUD ----------------
// Listar
app.get('/equipamentos', async (req, res) => {
  try {
    const equipamentos = await allAsync('SELECT * FROM equipamentos ORDER BY created_at DESC');
    res.render('equipamentos', { equipamentos });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao listar equipamentos.');
  }
});

// Form novo
app.get('/equipamentos/novo', (req, res) => {
  res.render('equipamentos_novo');
});

// Criar (com upload opcional de imagem)
app.post('/equipamentos', upload.single('imagem'), async (req, res) => {
  try {
    const { nome, codigo, local, descricao } = req.body;
    const imagem = req.file ? path.join('uploads', req.file.filename) : null;
    const result = await runAsync(
      `INSERT INTO equipamentos (nome, codigo, local, descricao, imagem) VALUES (?, ?, ?, ?, ?)`,
      [nome, codigo, local, descricao, imagem]
    );
    res.redirect('/equipamentos');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao criar equipamento.');
  }
});

// Editar (form)
app.get('/equipamentos/:id/editar', async (req, res) => {
  try {
    const id = req.params.id;
    const equipamento = await getAsync('SELECT * FROM equipamentos WHERE id = ?', [id]);
    if (!equipamento) return res.status(404).send('Equipamento não encontrado.');
    res.render('equipamentos_novo', { equipamento });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao carregar formulário.');
  }
});

// Atualizar
app.post('/equipamentos/:id', upload.single('imagem'), async (req, res) => {
  try {
    const id = req.params.id;
    const { nome, codigo, local, descricao } = req.body;
    const equipamento = await getAsync('SELECT * FROM equipamentos WHERE id = ?', [id]);
    if (!equipamento) return res.status(404).send('Equipamento não encontrado.');

    let imagem = equipamento.imagem;
    if (req.file) {
      // remove antigo (se existir)
      if (imagem) {
        const oldPath = path.join(__dirname, 'public', imagem);
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
      }
      imagem = path.join('uploads', req.file.filename);
    }
    await runAsync(
      `UPDATE equipamentos SET nome = ?, codigo = ?, local = ?, descricao = ?, imagem = ? WHERE id = ?`,
      [nome, codigo, local, descricao, imagem, id]
    );
    res.redirect('/equipamentos');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao atualizar equipamento.');
  }
});

// Deletar
app.post('/equipamentos/:id/delete', async (req, res) => {
  try {
    const id = req.params.id;
    const equipamento = await getAsync('SELECT * FROM equipamentos WHERE id = ?', [id]);
    if (!equipamento) return res.status(404).send('Equipamento não encontrado.');

    if (equipamento.imagem) {
      const imgPath = path.join(__dirname, 'public', equipamento.imagem);
      if (fs.existsSync(imgPath)) fs.unlinkSync(imgPath);
    }
    await runAsync('DELETE FROM equipamentos WHERE id = ?', [id]);
    res.redirect('/equipamentos');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao deletar equipamento.');
  }
});

// ---------------- Ordens (OS) ----------------
// Listar ordens
app.get('/ordens', async (req, res) => {
  try {
    const ordens = await allAsync(
      `SELECT o.*, e.nome AS equipamento_nome
       FROM ordens o
       LEFT JOIN equipamentos e ON e.id = o.equipamento_id
       ORDER BY o.aberta_em DESC`);
    res.render('ordens', { ordens });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao listar ordens.');
  }
});

// Form abrir OS (pode ser chamada por func)
app.get('/ordens/novo', async (req, res) => {
  try {
    const equipamentos = await allAsync('SELECT id, nome FROM equipamentos ORDER BY nome');
    res.render('abrir_os', { equipamentos });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao abrir formulário de OS.');
  }
});

// Criar OS
app.post('/ordens', async (req, res) => {
  try {
    const { equipamento_id, solicitante, tipo, descricao } = req.body;
    const result = await runAsync(
      `INSERT INTO ordens (equipamento_id, solicitante, tipo, descricao, status) VALUES (?, ?, ?, ?, 'aberta')`,
      [equipamento_id || null, solicitante, tipo, descricao]
    );
    res.redirect('/ordens');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao criar ordem.');
  }
});

// Visualizar OS
app.get('/ordens/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const ordem = await getAsync(
      `SELECT o.*, e.nome AS equipamento_nome, e.codigo AS equipamento_codigo
       FROM ordens o
       LEFT JOIN equipamentos e ON e.id = o.equipamento_id
       WHERE o.id = ?`,
      [id]
    );
    if (!ordem) return res.status(404).send('Ordem não encontrada.');
    res.render('ordens_fechar', { ordem });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao carregar ordem.');
  }
});

// Fechar OS (form confirm)
app.get('/ordens/:id/fechar', async (req, res) => {
  try {
    const id = req.params.id;
    const ordem = await getAsync('SELECT * FROM ordens WHERE id = ?', [id]);
    if (!ordem) return res.status(404).send('Ordem não encontrada.');
    res.render('ordens_fechar', { ordem });
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao abrir fechar OS.');
  }
});

// Fechar OS (ação)
app.post('/ordens/:id/fechar', async (req, res) => {
  try {
    const id = req.params.id;
    const { resultado } = req.body;
    await runAsync(
      `UPDATE ordens SET status = 'fechada', resultado = ?, fechada_em = CURRENT_TIMESTAMP WHERE id = ?`,
      [resultado, id]
    );
    res.redirect('/ordens');
  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao fechar ordem.');
  }
});

// Gerar PDF de solicitação (exemplo simples)
app.get('/solicitacao/pdf/:id', async (req, res) => {
  try {
    const id = req.params.id;
    const ordem = await getAsync(
      `SELECT o.*, e.nome AS equipamento_nome, e.codigo AS equipamento_codigo
       FROM ordens o
       LEFT JOIN equipamentos e ON e.id = o.equipamento_id
       WHERE o.id = ?`, [id]
    );
    if (!ordem) return res.status(404).send('Ordem não encontrada.');

    const doc = new PDFDocument({ margin: 40 });
    res.setHeader('Content-disposition', `attachment; filename=solicitacao_os_${id}.pdf`);
    res.setHeader('Content-type', 'application/pdf');
    doc.pipe(res);

    doc.fontSize(18).text('Solicitação de Serviço / Ordem de Serviço', { align: 'center' });
    doc.moveDown();

    doc.fontSize(12).text(`OS ID: ${ordem.id}`);
    doc.text(`Solicitante: ${ordem.solicitante || '-'}`);
    doc.text(`Tipo: ${ordem.tipo || '-'}`);
    doc.text(`Equipamento: ${ordem.equipamento_nome || '-'} (${ordem.equipamento_codigo || '-'})`);
    doc.moveDown();
    doc.text('Descrição:');
    doc.fontSize(11).text(ordem.descricao || '-', { indent: 10, lineGap: 4 });
    doc.moveDown(2);

    doc.text(`Status: ${ordem.status}`);
    if (ordem.status === 'fechada') {
      doc.text(`Fechada em: ${ordem.fechada_em}`);
      doc.text(`Resultado: ${ordem.resultado || '-'}`);
    }

    doc.moveDown(2);
    doc.text('Assinatura: ____________________________', { align: 'left' });

    doc.end();

  } catch (err) {
    console.error(err);
    res.status(500).send('Erro ao gerar PDF.');
  }
});

// ========== API endpoints JSON (opcionais) ==========
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

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
