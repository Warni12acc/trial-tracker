const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const upload   = multer({ dest: 'uploads/' });
const DATA_DIR = path.join(__dirname, 'data');

// Crée le dossier data s'il n'existe pas
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const ACTIVE_FILE   = path.join(DATA_DIR, 'active.json');

// ── Helpers persistence ──
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

// ── État en mémoire (chargé depuis le disque au démarrage) ──
let sessions      = readJSON(SESSIONS_FILE, []);   // sorties sauvegardées
let activeSession = readJSON(ACTIVE_FILE,   null); // session en cours

// ── Position courante (en mémoire uniquement, volontairement) ──
let currentPosition = activeSession ? activeSession.lastPosition || null : null;

// ═══════════════════════════════
//  ROUTES SESSION ACTIVE
// ═══════════════════════════════

// Pilote : envoie sa position
app.post('/api/position', (req, res) => {
  const { lat, lng, timestamp, accuracy } = req.body;
  currentPosition = { lat, lng, timestamp, accuracy, updatedAt: Date.now() };

  // Sauvegarde dans la session active
  if (activeSession) {
    activeSession.lastPosition = currentPosition;
    if (!activeSession.breadcrumbs) activeSession.breadcrumbs = [];
    activeSession.breadcrumbs.push({ lat, lng, timestamp, accuracy });
    writeJSON(ACTIVE_FILE, activeSession);
  }

  console.log(`Position reçue: ${lat}, ${lng}`);
  res.json({ success: true });
});

// Famille : récupère la dernière position
app.get('/api/position', (req, res) => {
  res.json({
    position: currentPosition,
    sessionActive: !!activeSession,
    breadcrumbs: activeSession ? activeSession.breadcrumbs || [] : []
  });
});

// Upload du fichier GPX + création session
app.post('/api/gpx', upload.single('gpx'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Fichier manquant' });

  const gpxData = fs.readFileSync(req.file.path, 'utf8');
  const { name, date, type } = req.body;

  activeSession = {
    id:          Date.now().toString(),
    name:        name || 'Sortie sans titre',
    date:        date || new Date().toISOString().split('T')[0],
    type:        type || 'trail',
    gpx:         gpxData,
    startedAt:   Date.now(),
    lastPosition: null,
    breadcrumbs: []
  };

  currentPosition = null;
  writeJSON(ACTIVE_FILE, activeSession);
  res.json({ success: true, session: activeSession });
});

// Récupère le GPX de la session active
app.get('/api/gpx', (req, res) => {
  res.json({ gpx: activeSession ? activeSession.gpx : null });
});

// Récupère les infos de la session active
app.get('/api/session/active', (req, res) => {
  res.json({ session: activeSession });
});

// Termine la session → archive dans sessions.json
app.post('/api/session/end', (req, res) => {
  if (activeSession) {
    activeSession.endedAt = Date.now();
    activeSession.lastPosition = currentPosition;
    sessions.unshift(activeSession); // plus récent en premier
    writeJSON(SESSIONS_FILE, sessions);
  }

  activeSession   = null;
  currentPosition = null;

  // Efface le fichier de session active
  try { fs.unlinkSync(ACTIVE_FILE); } catch {}

  res.json({ success: true });
});

// ═══════════════════════════════
//  ROUTES SORTIES SAUVEGARDÉES
// ═══════════════════════════════

// Liste toutes les sorties
app.get('/api/sessions', (req, res) => {
  // On envoie sans le GPX pour alléger
  const list = sessions.map(s => ({
    id:        s.id,
    name:      s.name,
    date:      s.date,
    type:      s.type,
    startedAt: s.startedAt,
    endedAt:   s.endedAt,
    stats:     s.stats || null
  }));
  res.json({ sessions: list });
});

// Récupère le détail (avec GPX) d'une sortie
app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Introuvable' });
  res.json({ session });
});

// Supprime une sortie
app.delete('/api/sessions/:id', (req, res) => {
  sessions = sessions.filter(s => s.id !== req.params.id);
  writeJSON(SESSIONS_FILE, sessions);
  res.json({ success: true });
});

// Sauvegarde les stats d'une sortie (distance, D+, etc.)
app.patch('/api/sessions/:id/stats', (req, res) => {
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Introuvable' });
  session.stats = req.body;
  writeJSON(SESSIONS_FILE, sessions);
  res.json({ success: true });
});

// ═══════════════════════════════
//  DÉMARRAGE
// ═══════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Serveur sur http://localhost:${PORT}`);
  console.log(`${sessions.length} sortie(s) chargée(s) depuis le disque`);
  if (activeSession) console.log(`Session active : ${activeSession.name}`);
});
