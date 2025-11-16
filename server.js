// ------------------------------------------
// IMPORTAÇÕES
// ------------------------------------------
const express = require("express");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const sqlite3 = require("sqlite3").verbose();
const QRCode = require("qrcode");

// ------------------------------------------
// CONFIGURAÇÕES DO EXPRESS
// ------------------------------------------
const app = express();

app.set("view engine", "ejs");
app.set("views", path.join(__dirname, "views"));

app.use("/public", express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads")));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Upload de arquivos temporários
const upload = multer({ dest: "uploads/tmp/" });

// ------------------------------------------
// BANCO DE DADOS
// ------------------------------------------
if (!fs.existsSync("uploads")) fs.mkdirSync("uploads", { recursive: true });
if (!fs.existsSync("uploads/equipamentos")) fs.mkdirSync("uploads/equipamentos", { recursive: true });
if (!fs.existsSync("uploads/ordens")) fs.mkdirSync("uploads/ordens", { recursive: true });
if (!fs.existsSync("data")) fs.mkdirSync("data");

const db = new sqlite3.Database("./data/database.sqlite");

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS equipamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT,
      setor TEXT,
      correias_utilizadas INTEGER DEFAULT 0,
      foto_path TEXT,
      qr_code TEXT
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS ordens_servico (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      equipamento_id INTEGER,
      descricao TEXT,
      foto_antes TEXT,
      foto_depois TEXT,
      status TEXT DEFAULT 'Aberta',
      data_abertura DATETIME DEFAULT CURRENT_TIMESTAMP,
      data_inicio DATETIME,
      data_fechamento DATETIME
    )
  `);
});

// ------------------------------------------
// ROTAS PRINCIPAIS
// ------------------------------------------

// Início → vai para login
app.get("/", (req, res) => {
  res.redirect("/admin/login");
});

// Tela de login
app.get("/admin/login", (req, res) => {
  res.render("admin/login");
});

// Dashboard básico
app.get("/admin/dashboard", (req, res) => {
  res.render("admin/dashboard");
});

// ------------------------------------------
// ROTAS DE EQUIPAMENTOS
// ------------------------------------------

// Listar equipamentos
app.get("/admin/equipamentos", (req, res) => {
  db.all("SELECT * FROM equipamentos ORDER BY nome ASC", [], (err, rows) => {
    res.render("admin/equipamentos", { equipamentos: rows || [] });
  });
});

// Tela de cadastro
app.get("/admin/equipamentos/novo", (req, res) => {
  res.render("admin/equipamentos_novo");
});

// Upload de foto
const uploadEquip = upload.single("foto");

// Salvar equipamento
app.post("/admin/equipamentos/novo", uploadEquip, (req, res) => {
  const { nome, setor, correias_utilizadas } = req.body;

  let foto_path = null;

  if (req.file) {
    const dest = `uploads/equipamentos/${Date.now()}_${req.file.originalname}`;
    fs.renameSync(req.file.path, dest);
    foto_path = dest;
  }

  db.run(
    "INSERT INTO equipamentos (nome, setor, correias_utilizadas, foto_path) VALUES (?, ?, ?, ?)",
    [nome, setor, correias_utilizadas || 0, foto_path],
    function (err) {
      if (err) return res.send("Erro ao salvar equipamento: " + err.message);

      const novoId = this.lastID;

      const qrConteudo = `${req.protocol}://${req.get("host")}/funcionario/abrir_os?equip_id=${novoId}`;
      const qrPath = `uploads/equipamentos/qrcode_${novoId}.png`;

      QRCode.toFile(qrPath, qrConteudo, {}, (err) => {
        if (!err) {
          db.run("UPDATE equipamentos SET qr_code=? WHERE id=?", [qrPath, novoId]);
        }
      });

      res.redirect("/admin/equipamentos");
    }
  );
});

// ------------------------------------------
// ROTAS DO FUNCIONÁRIO (ABRIR OS)
// ------------------------------------------

app.get("/funcionario/abrir_os", (req, res) => {
  const id = req.query.equip_id;

  db.get("SELECT * FROM equipamentos WHERE id=?", [id], (err, row) => {
    res.render("funcionario/abrir_os", { equip: row });
  });
});
// ------------------------------------------
// SALVAR OS ABERTA PELO FUNCIONÁRIO
// ------------------------------------------
const uploadOS = upload.single("foto_antes");

app.post("/funcionario/abrir_os", uploadOS, (req, res) => {
  const { equipamento_id, descricao } = req.body;

  let fotoAntes = null;

  if (req.file) {
    const dest = `uploads/ordens/${Date.now()}_antes_${req.file.originalname}`;
    fs.renameSync(req.file.path, dest);
    fotoAntes = dest;
  }

  db.run(
    `INSERT INTO ordens_servico (equipamento_id, descricao, foto_antes, status)
     VALUES (?, ?, ?, 'Aberta')`,
    [equipamento_id, descricao, fotoAntes],
    function (err) {
      if (err) return res.send("Erro ao salvar OS: " + err.message);

      res.redirect("/admin/ordens");
    }
  );
});
// ------------------------------------------
// LISTAR ORDENS DE SERVIÇO
// ------------------------------------------
app.get("/admin/ordens", (req, res) => {
  db.all(
    `SELECT o.*, e.nome AS equipamento_nome
     FROM ordens_servico o 
     LEFT JOIN equipamentos e ON e.id = o.equipamento_id
     ORDER BY o.data_abertura DESC`,
    [],
    (err, rows) => {
      res.render("admin/ordens", { ordens: rows || [] });
    }
  );
});

// ------------------------------------------
// SERVIDOR
// ------------------------------------------
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log("Rodando na porta", PORT));
