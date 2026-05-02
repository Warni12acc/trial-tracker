const express = require('express');
const cors    = require('cors');
const multer  = require('multer');
const fs      = require('fs');
const path    = require('path');
const https   = require('https');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

const upload   = multer({ dest: 'uploads/' });
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');
const ACTIVE_FILE   = path.join(DATA_DIR, 'active.json');
const STRAVA_FILE   = path.join(DATA_DIR, 'strava.json');

// ── Strava config depuis variables d'environnement Render ──
const STRAVA_CLIENT_ID     = process.env.STRAVA_CLIENT_ID;
const STRAVA_CLIENT_SECRET = process.env.STRAVA_CLIENT_SECRET;

// ── Helpers ──
function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), 'utf8');
}

function httpsGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { headers }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function httpsPost(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const postData = typeof body === 'string' ? body : new URLSearchParams(body).toString();
    const urlObj   = new URL(url);
    const options  = {
      hostname: urlObj.hostname,
      path:     urlObj.pathname + urlObj.search,
      method:   'POST',
      headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(postData), ...headers }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve(data); }
      });
    });
    req.on('error', reject);
    req.write(postData);
    req.end();
  });
}

// ── État ──
let sessions      = readJSON(SESSIONS_FILE, []);
let activeSession = readJSON(ACTIVE_FILE, null);
let currentPosition = activeSession ? activeSession.lastPosition || null : null;
let stravaTokens  = readJSON(STRAVA_FILE, null);

// ── Refresh Strava token si expiré ──
async function getValidStravaToken() {
  if (!stravaTokens) throw new Error('Non connecté à Strava');
  if (Date.now() / 1000 < stravaTokens.expires_at - 60) return stravaTokens.access_token;

  // Refresh
  const data = await httpsPost('https://www.strava.com/oauth/token', {
    client_id:     STRAVA_CLIENT_ID,
    client_secret: STRAVA_CLIENT_SECRET,
    grant_type:    'refresh_token',
    refresh_token: stravaTokens.refresh_token
  });

  if (data.access_token) {
    stravaTokens = data;
    writeJSON(STRAVA_FILE, stravaTokens);
    return stravaTokens.access_token;
  }
  throw new Error('Refresh token échoué');
}

// ═══════════════════════════════
//  ROUTES STRAVA OAuth
// ═══════════════════════════════

// Génère l'URL d'autorisation Strava
app.get('/api/strava/auth-url', (req, res) => {
  const redirectUri = `${req.protocol}://${req.get('host')}/api/strava/callback`;
  const url = `https://www.strava.com/oauth/authorize?client_id=${STRAVA_CLIENT_ID}&response_type=code&redirect_uri=${encodeURIComponent(redirectUri)}&approval_prompt=auto&scope=activity:read_all`;
  res.json({ url });
});

// Callback OAuth Strava — échange le code contre un token
app.get('/api/strava/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error || !code) {
    return res.redirect('/pilote.html?strava=error');
  }

  try {
    const data = await httpsPost('https://www.strava.com/oauth/token', {
      client_id:     STRAVA_CLIENT_ID,
      client_secret: STRAVA_CLIENT_SECRET,
      code,
      grant_type:    'authorization_code'
    });

    if (!data.access_token) throw new Error('Pas de token');

    stravaTokens = data;
    writeJSON(STRAVA_FILE, stravaTokens);

    res.redirect('/pilote.html?strava=connected');
  } catch (e) {
    console.error('Strava OAuth error:', e);
    res.redirect('/pilote.html?strava=error');
  }
});

// Statut connexion Strava
app.get('/api/strava/status', (req, res) => {
  if (!stravaTokens) return res.json({ connected: false });
  res.json({
    connected: true,
    athlete: stravaTokens.athlete ? {
      name:   `${stravaTokens.athlete.firstname} ${stravaTokens.athlete.lastname}`,
      avatar: stravaTokens.athlete.profile_medium
    } : null
  });
});

// Déconnexion Strava
app.post('/api/strava/disconnect', (req, res) => {
  stravaTokens = null;
  try { fs.unlinkSync(STRAVA_FILE); } catch {}
  res.json({ success: true });
});

// Liste des activités récentes Strava
app.get('/api/strava/activities', async (req, res) => {
  try {
    const token      = await getValidStravaToken();
    const page       = req.query.page || 1;
    const activities = await httpsGet(
      `https://www.strava.com/api/v3/athlete/activities?per_page=20&page=${page}`,
      { Authorization: `Bearer ${token}` }
    );

    // Filtre les activités avec GPS
    const filtered = activities
      .filter(a => a.start_latlng && a.start_latlng.length === 2)
      .map(a => ({
        id:       a.id,
        name:     a.name,
        type:     a.sport_type || a.type,
        date:     a.start_date_local,
        distance: (a.distance / 1000).toFixed(1),
        elevation: Math.round(a.total_elevation_gain),
        duration: Math.round(a.moving_time / 60)
      }));

    res.json({ activities: filtered });
  } catch (e) {
    console.error('Strava activities error:', e);
    res.status(401).json({ error: e.message });
  }
});

// Récupère le GPX d'une activité Strava (reconstruit depuis les streams)
app.get('/api/strava/activity/:id/gpx', async (req, res) => {
  try {
    const token = await getValidStravaToken();
    const id    = req.params.id;

    // Récupère les streams latlng + altitude + time
    const streams = await httpsGet(
      `https://www.strava.com/api/v3/activities/${id}/streams?keys=latlng,altitude,time&key_by_type=true`,
      { Authorization: `Bearer ${token}` }
    );

    if (!streams.latlng || !streams.latlng.data) {
      return res.status(404).json({ error: 'Pas de données GPS pour cette activité' });
    }

    const latlng   = streams.latlng.data;
    const altitude = streams.altitude ? streams.altitude.data : null;
    const time     = streams.time     ? streams.time.data     : null;

    // Récupère les infos de l'activité pour le nom et la date
    const activity = await httpsGet(
      `https://www.strava.com/api/v3/activities/${id}`,
      { Authorization: `Bearer ${token}` }
    );

    const startDate = new Date(activity.start_date);

    // Construit le GPX
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Trial Tracker" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${(activity.name || 'Activité Strava').replace(/[<>&"]/g, '')}</name>
    <time>${startDate.toISOString()}</time>
  </metadata>
  <trk>
    <name>${(activity.name || 'Activité Strava').replace(/[<>&"]/g, '')}</name>
    <trkseg>\n`;

    latlng.forEach((pt, i) => {
      const ele = altitude ? `\n        <ele>${altitude[i].toFixed(1)}</ele>` : '';
      let timeTag = '';
      if (time) {
        const t = new Date(startDate.getTime() + time[i] * 1000);
        timeTag = `\n        <time>${t.toISOString()}</time>`;
      }
      gpx += `      <trkpt lat="${pt[0]}" lon="${pt[1]}">${ele}${timeTag}\n      </trkpt>\n`;
    });

    gpx += `    </trkseg>
  </trk>
</gpx>`;

    res.json({
      gpx,
      name:     activity.name,
      date:     activity.start_date_local?.split('T')[0],
      type:     activity.sport_type || activity.type,
      distance: (activity.distance / 1000).toFixed(1),
      elevation: Math.round(activity.total_elevation_gain)
    });

  } catch (e) {
    console.error('Strava GPX error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ═══════════════════════════════
//  ROUTES KOMOOT
// ═══════════════════════════════

// Extrait le GPX d'un lien Komoot public (tour ou activité)
app.post('/api/komoot/import', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  // Extraire l'ID du tour depuis l'URL
  // Formats: komoot.com/tour/123456 ou komoot.com/*/tour/123456
  const match = url.match(/tour\/(\d+)/);
  if (!match) {
    return res.status(400).json({ error: 'URL Komoot invalide — colle un lien de type komoot.com/tour/XXXXXXX' });
  }
  const tourId = match[1];

  try {
    // Récupère les infos du tour via l'API publique Komoot
    const tourData = await httpsGet(
      `https://www.komoot.com/api/v007/tours/${tourId}?_embedded=coordinates,way_types,surfaces,directions,participants,timeline`,
      {
        'Accept': 'application/json',
        'User-Agent': 'Mozilla/5.0 (compatible; TrialTracker/1.0)'
      }
    );

    if (tourData.error || !tourData.id) {
      return res.status(404).json({ error: 'Tour introuvable ou privé. Vérifie que l\'activité est publique.' });
    }

    // Récupère les coordonnées GPS
    const coords = tourData._embedded?.coordinates?.items;
    if (!coords || coords.length === 0) {
      return res.status(404).json({ error: 'Pas de données GPS pour ce tour.' });
    }

    // Infos du tour
    const name     = tourData.name || 'Tour Komoot';
    const distance = tourData.distance ? (tourData.distance / 1000).toFixed(1) : null;
    const elevation= tourData.elevation_up ? Math.round(tourData.elevation_up) : null;
    const date     = tourData.date ? tourData.date.split('T')[0] : new Date().toISOString().split('T')[0];
    const type     = tourData.type === 'tour_recorded' ? 'trail' : 'planned';

    // Construit le GPX
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Trial Tracker" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata>
    <name>${name.replace(/[<>&"]/g, '')}</name>
    <time>${tourData.date || new Date().toISOString()}</time>
  </metadata>
  <trk>
    <name>${name.replace(/[<>&"]/g, '')}</name>
    <trkseg>\n`;

    coords.forEach(pt => {
      const ele = pt.alt != null ? `\n        <ele>${pt.alt.toFixed(1)}</ele>` : '';
      gpx += `      <trkpt lat="${pt.lat}" lon="${pt.lng}">${ele}\n      </trkpt>\n`;
    });

    gpx += `    </trkseg>
  </trk>
</gpx>`;

    res.json({ gpx, name, date, type, distance, elevation, tourId });

  } catch (e) {
    console.error('Komoot import error:', e);
    res.status(500).json({ error: 'Erreur lors de la récupération du tour : ' + e.message });
  }
});

// ═══════════════════════════════
//  ROUTES SESSION ACTIVE
// ═══════════════════════════════

app.post('/api/position', (req, res) => {
  const { lat, lng, timestamp, accuracy } = req.body;
  currentPosition = { lat, lng, timestamp, accuracy, updatedAt: Date.now() };
  if (activeSession) {
    activeSession.lastPosition = currentPosition;
    if (!activeSession.breadcrumbs) activeSession.breadcrumbs = [];
    activeSession.breadcrumbs.push({ lat, lng, timestamp, accuracy });
    writeJSON(ACTIVE_FILE, activeSession);
  }
  console.log(`Position reçue: ${lat}, ${lng}`);
  res.json({ success: true });
});

app.get('/api/position', (req, res) => {
  res.json({
    position: currentPosition,
    sessionActive: !!activeSession,
    breadcrumbs: activeSession ? activeSession.breadcrumbs || [] : []
  });
});

app.post('/api/gpx', upload.single('gpx'), (req, res) => {
  let gpxData;
  if (req.file) {
    gpxData = fs.readFileSync(req.file.path, 'utf8');
  } else if (req.body.gpxContent) {
    gpxData = req.body.gpxContent;
  } else {
    return res.status(400).json({ error: 'Fichier ou contenu GPX manquant' });
  }

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

app.get('/api/gpx', (req, res) => {
  res.json({ gpx: activeSession ? activeSession.gpx : null });
});

app.get('/api/session/active', (req, res) => {
  res.json({ session: activeSession });
});

app.post('/api/session/end', (req, res) => {
  if (activeSession) {
    activeSession.endedAt    = Date.now();
    activeSession.lastPosition = currentPosition;
    sessions.unshift(activeSession);
    writeJSON(SESSIONS_FILE, sessions);
  }
  activeSession   = null;
  currentPosition = null;
  try { fs.unlinkSync(ACTIVE_FILE); } catch {}
  res.json({ success: true });
});

// ═══════════════════════════════
//  ROUTES SORTIES SAUVEGARDÉES
// ═══════════════════════════════

app.get('/api/sessions', (req, res) => {
  const list = sessions.map(s => ({
    id: s.id, name: s.name, date: s.date, type: s.type,
    startedAt: s.startedAt, endedAt: s.endedAt, stats: s.stats || null
  }));
  res.json({ sessions: list });
});

app.get('/api/sessions/:id', (req, res) => {
  const session = sessions.find(s => s.id === req.params.id);
  if (!session) return res.status(404).json({ error: 'Introuvable' });
  res.json({ session });
});

app.delete('/api/sessions/:id', (req, res) => {
  sessions = sessions.filter(s => s.id !== req.params.id);
  writeJSON(SESSIONS_FILE, sessions);
  res.json({ success: true });
});

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
  console.log(`Strava: ${stravaTokens ? 'connecté' : 'non connecté'}`);
  console.log(`${sessions.length} sortie(s) chargée(s)`);
});
