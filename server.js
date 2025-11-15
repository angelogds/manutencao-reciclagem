
/**
 * Manutenção Reciclagem Campo do Gado - FINAL
 * Integrated with prototype assets (if any). EJS frontend + admin + public panels.
 */
const express = require('express');
const path = require('path');
const fs = require('fs');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const multer = require('multer');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const session = require('express-session');
const flash = require('connect-flash');
const bcrypt = require('bcryptjs');
const methodOverride = require('method-override');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

app.set('view engine','ejs');
app.set('views', path.join(__dirname,'views'));
app.use('/public', express.static(path.join(__dirname,'public')));
app.use('/uploads', express.static(path.join(__dirname,'uploads')));
app.use('/prototype', express.static(path.join(__dirname,'prototype')));
app.use(bodyParser.urlencoded({ extended: true }));
app.use(bodyParser.json());
app.use(methodOverride('_method'));
app.use(session({ secret: process.env.SESSION_SECRET || 'segredo-padrao', resave:false, saveUninitialized:true }));
app.use(flash());

// locals
app.use((req,res,next)=>{
  res.locals.success = req.flash('success');
  res.locals.error = req.flash('error');
  res.locals.user = req.session.user || null;
  next();
});

// ensure folders
['data','uploads','uploads/fotos','uploads/manuals','uploads/ordens','uploads/logos'].forEach(d=>{ if(!fs.existsSync(d)) fs.mkdirSync(d,{recursive:true}); });

const DB_FILE = path.join(__dirname,'data','database.db');
const db = new sqlite3.Database(DB_FILE);

// create tables
db.serialize(()=>{
  db.run(`CREATE TABLE IF NOT EXISTS users ( id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE, password TEXT, role TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS equipamentos ( id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT, modelo TEXT, setor TEXT, correias_utilizadas INTEGER DEFAULT 0, foto TEXT, manual_pdf TEXT, qr_url TEXT )`);
  db.run(`CREATE TABLE IF NOT EXISTS correias ( id INTEGER PRIMARY KEY AUTOINCREMENT, modelo TEXT UNIQUE, quantidade INTEGER DEFAULT 0, minimo INTEGER DEFAULT 1 )`);
  db.run(`CREATE TABLE IF NOT EXISTS ordens_servico ( id INTEGER PRIMARY KEY AUTOINCREMENT, equipamento_id INTEGER, descricao TEXT, status TEXT DEFAULT 'Aberta', foto_antes TEXT, foto_depois TEXT, aberto_em DATETIME DEFAULT CURRENT_TIMESTAMP, inicio_em DATETIME, fim_em DATETIME, tempo_minutos INTEGER DEFAULT 0, trocou_correia INTEGER DEFAULT 0 )`);
});

// seed admin
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || 'admin@campodogado.com';
const ADMIN_PASS = process.env.ADMIN_PASS || '12345';
db.get('SELECT id FROM users WHERE email = ?', [ADMIN_EMAIL], (err,row)=>{
  if(err) console.error(err);
  if(!row){
    const hash = bcrypt.hashSync(ADMIN_PASS, 10);
    db.run('INSERT INTO users (email,password,role) VALUES (?,?,?)', [ADMIN_EMAIL, hash, 'admin']);
    console.log('Admin user created:', ADMIN_EMAIL);
  }
});

// sync belts_seed.json if exists
const seedPath = path.join(__dirname,'belts_seed.json');
if(fs.existsSync(seedPath)){
  try{
    const seed = JSON.parse(fs.readFileSync(seedPath,'utf8'));
    seed.forEach(item=>{
      db.get('SELECT id FROM correias WHERE modelo = ?', [item.model], (e,row)=>{
        if(row && row.id){
          db.run('UPDATE correias SET quantidade = ?, minimo = ? WHERE id = ?', [item.stock || 0, 1, row.id]);
        } else {
          db.run('INSERT INTO correias (modelo, quantidade, minimo) VALUES (?,?,?)', [item.model, item.stock || 0, 1]);
        }
      });
    });
    console.log('Belts seed synchronized.');
  } catch(e){ console.error('Seed parse error', e); }
}

// multer storage (compatible)
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    if(file.fieldname === 'manual_pdf') cb(null, path.join(__dirname,'uploads','manuals'));
    else cb(null, path.join(__dirname,'uploads','fotos'));
  },
  filename: function (req, file, cb) {
    const name = Date.now() + '-' + file.originalname.replace(/\s+/g,'_');
    cb(null, name);
  }
});
const upload = multer({ storage: storage });

// auth middleware
function requireAdmin(req,res,next){
  if(req.session.user && req.session.user.role === 'admin') return next();
  req.flash('error','Acesso negado');
  res.redirect('/admin/login');
}

// Routes - admin auth
app.get('/admin/login',(req,res)=> res.render('admin/login'));
app.post('/admin/login',(req,res)=>{
  const { email, password } = req.body;
  db.get('SELECT * FROM users WHERE email = ?', [email], (err,user)=>{
    if(err || !user){ req.flash('error','Credenciais inválidas'); return res.redirect('/admin/login'); }
    if(!bcrypt.compareSync(password, user.password)){ req.flash('error','Credenciais inválidas'); return res.redirect('/admin/login'); }
    req.session.user = { id: user.id, email: user.email, role: user.role };
    res.redirect('/admin');
  });
});
app.get('/admin/logout',(req,res)=>{ req.session.destroy(()=>res.redirect('/admin/login')); });

// admin dashboard
app.get('/admin', requireAdmin, (req,res)=>{
  db.all('SELECT * FROM equipamentos ORDER BY id DESC', [], (err,equip)=> {
    db.all('SELECT * FROM ordens_servico ORDER BY aberto_em DESC LIMIT 10', [], (err2,os)=> {
      res.render('admin/dashboard', { equipamentos: equip, ordens: os });
    });
  });
});

// equipamentos admin
app.get('/admin/equipamentos', requireAdmin, (req,res)=> db.all('SELECT * FROM equipamentos ORDER BY id DESC', [], (e,rows)=> res.render('admin/equipamentos',{ equipamentos: rows })));
app.get('/admin/equipamentos/novo', requireAdmin, (req,res)=> res.render('admin/equipamento_form', { equipamento: null }));
app.post('/admin/equipamentos', requireAdmin, upload.fields([{ name:'foto' }, { name:'manual_pdf' }]), (req,res)=>{
  const { nome, modelo, setor, correias_utilizadas } = req.body;
  const foto = req.files && req.files['foto'] ? req.files['foto'][0].filename : null;
  const manual = req.files && req.files['manual_pdf'] ? req.files['manual_pdf'][0].filename : null;
  db.run('INSERT INTO equipamentos (nome,modelo,setor,correias_utilizadas,foto,manual_pdf) VALUES (?,?,?,?,?,?)', [nome,modelo,setor, correias_utilizadas||0, foto, manual], function(err){
    if(err){ req.flash('error','Erro ao salvar'); return res.redirect('/admin/equipamentos'); }
    const id = this.lastID;
    const qrUrl = `${req.protocol}://${req.get('host')}/abrir-os?id=${id}`;
    db.run('UPDATE equipamentos SET qr_url = ? WHERE id = ?', [qrUrl, id]);
    req.flash('success','Equipamento cadastrado'); res.redirect('/admin/equipamentos');
  });
});
app.get('/admin/equipamentos/:id', requireAdmin, (req,res)=> db.get('SELECT * FROM equipamentos WHERE id = ?', [req.params.id], (e,row)=> res.render('admin/equipamento_show',{ equipamento: row })));

// correias admin
app.get('/admin/correias', requireAdmin, (req,res)=> db.all('SELECT * FROM correias ORDER BY modelo', [], (e,rows)=> res.render('admin/correias',{ correias: rows })));
app.get('/admin/correias/novo', requireAdmin, (req,res)=> res.render('admin/correia_form',{ correia:null }));
app.post('/admin/correias', requireAdmin, (req,res)=> {
  const { modelo, quantidade, minimo } = req.body;
  db.run('INSERT OR IGNORE INTO correias (modelo,quantidade,minimo) VALUES (?,?,?)', [modelo, quantidade||0, minimo||1], err=>{ req.flash('success','Correia cadastrada'); res.redirect('/admin/correias'); });
});
app.post('/admin/correias/:id/update', requireAdmin, (req,res)=> {
  const { quantidade, minimo } = req.body;
  db.run('UPDATE correias SET quantidade = ?, minimo = ? WHERE id = ?', [quantidade||0, minimo||1, req.params.id], err=>{ req.flash('success','Atualizado'); res.redirect('/admin/correias'); });
});

// admin ordens
app.get('/admin/os', requireAdmin, (req,res)=> db.all('SELECT o.*, e.nome as equipamento_nome FROM ordens_servico o LEFT JOIN equipamentos e ON e.id = o.equipamento_id ORDER BY o.aberto_em DESC', [], (e,rows)=> res.render('admin/os',{ ordens: rows })));
app.get('/admin/os/:id', requireAdmin, (req,res)=> db.get('SELECT o.*, e.nome as equipamento_nome FROM ordens_servico o LEFT JOIN equipamentos e ON e.id = o.equipamento_id WHERE o.id = ?', [req.params.id], (e,row)=> res.render('admin/os_show',{ os: row })));

// public panel - open OS via QR
app.get('/abrir-os', (req,res)=>{
  const equip_id = req.query.id;
  if(!equip_id) return res.send('ID do equipamento não informado');
  db.get('SELECT * FROM equipamentos WHERE id = ?', [equip_id], (err,equip)=>{
    if(!equip) return res.send('Equipamento não encontrado');
    db.get("SELECT * FROM ordens_servico WHERE equipamento_id = ? AND status IN ('Aberta','Em andamento') ORDER BY aberto_em DESC LIMIT 1", [equip_id], (err,os)=>{
      res.render('public/abrir_os', { equipamento: equip, os: os || null });
    });
  });
});

// create order (employee)
app.post('/ordens', upload.single('foto_antes'), (req,res)=>{
  const { equipamento_id, descricao } = req.body;
  const foto = req.file ? req.file.filename : null;
  db.run('INSERT INTO ordens_servico (equipamento_id,descricao,foto_antes,status) VALUES (?,?,?,?)', [equipamento_id, descricao, foto, 'Aberta'], function(err){
    if(err) return res.status(500).send('Erro ao criar OS');
    res.render('public/os_criada', { id: this.lastID });
  });
});

// mechanic start and finish
app.post('/ordens/:id/start', (req,res)=>{
  const id = req.params.id;
  db.run('UPDATE ordens_servico SET status = ?, inicio_em = CURRENT_TIMESTAMP WHERE id = ?', ['Em andamento', id], function(err){
    if(err) return res.status(500).send('Erro ao iniciar'); res.json({ ok:true });
  });
});
app.post('/ordens/:id/finish', upload.single('foto_depois'), (req,res)=>{
  const id = req.params.id;
  const foto_depois = req.file ? req.file.filename : null;
  db.get('SELECT inicio_em, aberto_em FROM ordens_servico WHERE id = ?', [id], (err,row)=>{
    const inicio = row && row.inicio_em ? new Date(row.inicio_em) : new Date(row.aberto_em);
    const fim = new Date();
    const diffMin = Math.round((fim - inicio)/60000);
    db.run('UPDATE ordens_servico SET status = ?, fim_em = CURRENT_TIMESTAMP, foto_depois = ?, tempo_minutos = ? WHERE id = ?', ['Fechada', foto_depois, diffMin, id], function(err2){
      if(err2) return res.status(500).send('Erro ao finalizar');
      const modelo = req.body.trocou_modelo;
      const qtd = parseInt(req.body.trocou_qtd || '0');
      if(modelo && qtd > 0){
        db.get('SELECT * FROM correias WHERE modelo = ?', [modelo], (e,c)=>{
          if(c){
            const novo = Math.max(0, (c.quantidade||0) - qtd);
            db.run('UPDATE correias SET quantidade = ? WHERE id = ?', [novo, c.id]);
          }
        });
      }
      res.json({ ok:true });
    });
  });
});

// qrcode image
app.get('/qrcode/:id', (req,res)=>{
  const id = req.params.id;
  const target = `${req.protocol}://${req.get('host')}/abrir-os?id=${id}`;
  res.setHeader('Content-Type','image/png');
  QRCode.toFileStream(res, target);
});

// download manual
app.get('/manual/:id', (req,res)=>{
  db.get('SELECT manual_pdf FROM equipamentos WHERE id = ?', [req.params.id], (err,row)=>{
    if(!row || !row.manual_pdf) return res.status(404).send('Manual não encontrado');
    const p = path.join(__dirname,'uploads','manuals', row.manual_pdf);
    res.download(p);
  });
});

// backup route - admin only
app.get('/backup', requireAdmin, (req,res)=>{
  res.download(DB_FILE, 'database_backup.db');
});

// import prototype route (optional) - serve prototype pages
app.get('/prototype/:page', (req,res)=>{
  const p = req.params.page;
  const filePath = path.join(__dirname,'prototype', p);
  if(fs.existsSync(filePath)) return res.sendFile(filePath);
  res.status(404).send('Not found');
});

// catch-all
app.get('*', (req,res)=>{
  if(req.session.user && req.session.user.role === 'admin') return res.redirect('/admin');
  res.redirect('/admin/login');
});

app.listen(PORT, ()=> console.log('Manutenção Reciclagem - rodando na porta', PORT));
