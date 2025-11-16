// Dependências principais
const express = require("express");
const path = require("path");
const fs = require("fs");
const PDFDocument = require("pdfkit");
const sqlite3 = require("sqlite3").verbose();
const session = require("express-session");
const bcrypt = require("bcryptjs");
const multer = require("multer");
const qrcode = require("qrcode");
const methodOverride = require("method-override");

// Criação do app
const app = express();

// Configurações básicas
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(methodOverride("_method"));
app.use(express.static("public"));
app.use("/uploads", express.static("uploads"));

// Sessão
app.use(
  session({
    secret: "segredo-super-seguro",
    resave: false,
    saveUninitialized: false,
  })
);

// Banco de dados SQLite
const db = new sqlite3.Database("./data/database.sqlite", (err) => {
  if (err) {
    console.error("Erro ao conectar ao banco:", err.message);
  } else {
    console.log("Banco SQLite conectado com sucesso!");
  }
});

// Configuração do Multer (upload de arquivos)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/tmp");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const upload = multer({ storage });

// ------------------------------------------
// ROTAS DE LOGIN
// ------------------------------------------
app.get("/admin/login", (req, res) => {
  res.render("admin/login");
});

app.post("/admin/login", (req, res) => {
  const { email, senha } = req.body;
  db.get("SELECT * FROM usuarios WHERE email=?", [email], (err, user) => {
    if (user && bcrypt.compareSync(senha, user.senha)) {
      req.session.user = user;
      res.redirect("/admin/dashboard");
    } else {
      res.send("Login inválido");
    }
  });
});

// ------------------------------------------
// DASHBOARD
// ------------------------------------------
app.get("/admin/dashboard", (req, res) => {
  res.render("admin/dashboard", { user: req.session.user });
});

// ------------------------------------------
// EQUIPAMENTOS
// ------------------------------------------
app.get("/admin/equipamentos", (req, res) => {
  db.all("SELECT * FROM equipamentos", [], (err, rows) => {
    res.render("admin/equipamentos", { equipamentos: rows });
  });
});

app.get("/admin/equipamentos/novo", (req, res) => {
  res.render("admin/equipamentos_novo");
});

app.post("/admin/equipamentos", upload.single("foto"), (req, res) => {
  const { nome, descricao } = req.body;
  const foto = req.file ? req.file.path : null;
  db.run(
    "INSERT INTO equipamentos (nome, descricao, foto) VALUES (?,?,?)",
    [nome, descricao, foto],
    function (err) {
      res.redirect("/admin/equipamentos");
    }
  );
});

// ------------------------------------------
// ORDENS DE SERVIÇO
// ------------------------------------------
app.get("/admin/ordens", (req, res) => {
  db.all(
    `SELECT o.*, e.nome AS equipamento_nome 
     FROM ordens_servico o 
     LEFT JOIN equipamentos e ON e.id = o.equipamento_id 
     ORDER BY o.data_abertura DESC`,
    [],
    (err, rows) => {
      res.render("admin/ordens", { ordens: rows });
    }
  );
});

// ------------------------------------------
// FUNCIONÁRIO ABRIR OS VIA QR CODE
// ------------------------------------------
app.get("/funcionario/abrir_os", (req, res) => {
  const equip_id = req.query.equip_id;
  res.render("funcionario/abrir_os", { equip_id });
});

app.post("/funcionario/abrir_os", (req, res) => {
  const { equip_id, descricao } = req.body;
  db.run(
    "INSERT INTO ordens_servico (equipamento_id, descricao, status, data_abertura) VALUES (?,?,?,datetime('now'))",
    [equip_id, descricao, "Aberta"],
    function (err) {
      res.send("Ordem de serviço aberta com sucesso!");
    }
  );
});

// ------------------------------------------
// RELATÓRIO PDF ESTILIZADO
// ------------------------------------------
app.get("/admin/ordens/report", (req, res) => {
  const id = req.query.id;

  const sql = id
    ? `SELECT o.*, e.nome AS equipamento_nome FROM ordens_servico o
       LEFT JOIN equipamentos e ON e.id = o.equipamento_id
       WHERE o.id=?`
    : `SELECT o.*, e.nome AS equipamento_nome FROM ordens_servico o
       LEFT JOIN equipamentos e ON e.id = o.equipamento_id
       ORDER BY o.data_abertura DESC`;

  const params = id ? [id] : [];

  db.all(sql, params, (err, rows) => {
    const doc = new PDFDocument({ margin: 40, size: "A4" });

    const filename = id
      ? `os_${id}.pdf`
      : `relatorio_${Date.now()}.pdf`;

    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.setHeader("Content-Type", "application/pdf");

    doc.pipe(res);

    // Cabeçalho com logo
    if (fs.existsSync("public/logo.png")) {
      doc.image("public/logo.png", 40, 40, { width: 80 });
    }
    doc.fontSize(22).fillColor("#222")
       .text("Campo do Gado - Relatório de Ordens de Serviço", 140, 50);
    doc.moveDown(2);

    rows.forEach((r, index) => {
      doc.fontSize(16).fillColor("#333").text(`OS #${r.id}`, { underline: true });
      doc.moveDown(0.5);

      doc.fontSize(12).fillColor("#000").text(`Equipamento: ${r.equipamento_nome}`);
      doc.text(`Status: ${r.status}`);
      doc.text(`Técnico: ${r.tecnico_nome || "-"}`);
      doc.text(`Abertura: ${r.data_abertura}`);
      doc.text(`Início: ${r.data_inicio || "-"}`);
      doc.text(`Fechamento: ${r.data_fechamento || "-"}`);

      if (r.tempo_total != null) {
        const s = r.tempo_total;
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        doc.text(`Tempo total: ${h}h ${m}m ${sec}s`);
      }

      doc.moveDown();
      doc.font("Helvetica-Bold").text("Descrição:");
      doc.font("Helvetica").text(r.descricao || "-", { indent: 20 });
      doc.moveDown();

      // Fotos
      if (r.foto_antes && fs.existsSync(r.foto_antes)) {
        doc.font("Helvetica-Bold").text("Foto ANTES:");
        doc.image(r.foto_antes, { width: 200 });
        doc.moveDown();
      }

      if (r.foto_depois && fs.existsSync(r.foto_depois)) {
        doc.font("Helvetica-Bold").text("Foto DEPOIS:");
        doc.image(r.foto_depois, { width: 200 });
        doc.moveDown();
      }

      // Linha separadora
      doc.moveDown();
      doc.strokeColor("#aaa").lineWidth(1)
         .moveTo(40, doc.y).lineTo(550, doc.y).stroke();

      // Nova página apenas se não for o último
      if (index < rows.length - 1) {
        doc.addPage();
      }
    });

    doc.end();
  });
});
const multer = require("multer");

// Upload de fotos de equipamentos
const storageEquipamentos = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/equipamentos");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const uploadEquipamentos = multer({ storage: storageEquipamentos });

// Upload de fotos de ordens
const storageOrdens = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, "uploads/ordens");
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + "-" + file.originalname);
  },
});
const uploadOrdens = multer({ storage: storageOrdens });
app.post("/admin/equipamentos", uploadEquipamentos.single("foto"), (req, res) => {
  const { nome, descricao } = req.body;
  const foto = req.file ? req.file.path : null;

  db.run(
    "INSERT INTO equipamentos (nome, descricao, foto) VALUES (?,?,?)",
    [nome, descricao, foto],
    function (err) {
      res.redirect("/admin/equipamentos");
    }
  );
});
app.post("/admin/ordens", uploadOrdens.single("foto"), (req, res) => {
  const { equipamento_id, descricao } = req.body;
  const foto = req.file ? req.file.path : null;

  db.run(
    "INSERT INTO ordens_servico (equipamento_id, descricao, status, foto_antes, data_abertura) VALUES (?,?,?,?,datetime('now'))",
    [equipamento_id, descricao, "Aberta", foto],
    function (err) {
      res.redirect("/admin/ordens");
    }
  );
});

// ------------------------------------------
// Inicialização do servidor
// ------------------------------------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
