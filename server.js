// ------------------------------------------
// ROTAS DE EQUIPAMENTOS
// ------------------------------------------

// Listar todos os equipamentos no painel admin
app.get("/admin/equipamentos", (req, res) => {
  db.all("SELECT * FROM equipamentos ORDER BY nome ASC", [], (err, rows) => {
    res.render("admin/equipamentos", { equipamentos: rows || [] });
  });
});

// Tela para cadastrar novo equipamento
app.get("/admin/equipamentos/novo", (req, res) => {
  res.render("admin/equipamentos_novo");
});

// Upload de foto
const uploadEquip = upload.single("foto");

// Salvar novo equipamento
app.post("/admin/equipamentos/novo", uploadEquip, (req, res) => {
  const { nome, setor, correias_utilizadas } = req.body;

  let foto_path = null;

  if (req.file) {
    const dest = `uploads/equipamentos/${Date.now()}_${req.file.originalname}`;
    fs.renameSync(req.file.path, dest);
    foto_path = dest;
  }

  // Inserir no banco
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
