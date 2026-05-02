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

app.post('/api/komoot/import', async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: 'URL manquante' });

  const match = url.match(/(?:smarttour|tour)\/([a-zA-Z0-9]+)/);
  if (!match) {
    return res.status(400).json({ error: 'URL Komoot invalide — colle un lien komoot.com/tour/... ou komoot.com/smarttour/...' });
  }
  const tourId = match[1];

  try {
    // Komoot expose les données de la page en JSON dans un tag <script>
    // On fetch la page HTML et on extrait le JSON embarqué
    const pageHtml = await new Promise((resolve, reject) => {
      const urlObj = new URL(`https://www.komoot.com/smarttour/${tourId}`);
      const options = {
        hostname: urlObj.hostname,
        path: urlObj.pathname,
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9',
        }
      };
      const request = https.request(options, (response) => {
        // Gère les redirections
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location;
          const redirObj = new URL(redirectUrl.startsWith('http') ? redirectUrl : `https://www.komoot.com${redirectUrl}`);
          const redirOptions = { ...options, hostname: redirObj.hostname, path: redirObj.pathname + redirObj.search };
          https.request(redirOptions, (r2) => {
            let d = '';
            r2.on('data', c => d += c);
            r2.on('end', () => resolve(d));
          }).on('error', reject).end();
          return;
        }
        let data = '';
        response.on('data', chunk => data += chunk);
        response.on('end', () => resolve(data));
      });
      request.on('error', reject);
      request.end();
    });

    // Cherche le JSON embarqué dans la page
    // Komoot injecte les données du tour dans window.__komoot_store__ ou similaire
    let tourData = null;

    // Méthode 1 : cherche les coordonnées dans les données JSON de la page
    const jsonMatch = pageHtml.match(/kmtBoot\.init\(({.+})\)/s) ||
                      pageHtml.match(/"coordinates"\s*:\s*\{"items"\s*:\s*(\[.+?\])/s) ||
                      pageHtml.match(/window\.__INITIAL_STATE__\s*=\s*({.+?})\s*;<\/script>/s);

    // Méthode 2 : extraction directe des coordonnées via regex
    const coordsMatch = pageHtml.match(/"latlng"\s*:\s*\[([^\]]+)\]/g) ||
                        pageHtml.match(/{"lat"\s*:\s*([\d.]+)\s*,\s*"lng"\s*:\s*([\d.]+)/g);

    // Méthode 3 : cherche le bloc de données de la carte
    const tileDataMatch = pageHtml.match(/"path"\s*:\s*"([A-Za-z0-9+/=_-]+)"/);

    // Extraction du nom du tour depuis la page HTML
    const nameMatch = pageHtml.match(/<title[^>]*>([^<]+)<\/title>/) ||
                      pageHtml.match(/"name"\s*:\s*"([^"]+)"/);
    const tourName = nameMatch ? nameMatch[1].replace(' | komoot', '').trim() : 'Tour Komoot';

    // Extraction des points GPS depuis les données JSON embarquées
    const pointsData = [];

    // Cherche le pattern des coordonnées Komoot dans le HTML
    const latLngPattern = /"lat"\s*:\s*([\d.-]+)\s*,\s*"lng"\s*:\s*([\d.-]+)(?:\s*,\s*"alt"\s*:\s*([\d.-]+))?/g;
    let ptMatch;
    while ((ptMatch = latLngPattern.exec(pageHtml)) !== null) {
      pointsData.push({
        lat: parseFloat(ptMatch[1]),
        lng: parseFloat(ptMatch[2]),
        alt: ptMatch[3] ? parseFloat(ptMatch[3]) : null
      });
    }

    if (pointsData.length < 2) {
      // Fallback : essaie l'API avec un User-Agent différent
      const apiData = await httpsGet(
        `https://www.komoot.com/api/v007/tours/${tourId}?_embedded=coordinates`,
        {
          'User-Agent': 'Komoot/12.0 (iPhone; iOS 16.0)',
          'Accept': 'application/json',
          'Referer': 'https://www.komoot.com/'
        }
      );

      if (apiData && apiData._embedded && apiData._embedded.coordinates) {
        const items = apiData._embedded.coordinates.items;
        items.forEach(pt => pointsData.push({ lat: pt.lat, lng: pt.lng, alt: pt.alt || null }));
        tourData = apiData;
      }
    }

    if (pointsData.length < 2) {
      return res.status(404).json({
        error: 'Impossible d\'extraire le tracé. Ce tour est peut-être privé ou le format a changé. Utilise l\'option "Fichier GPX" à la place.'
      });
    }

    // Dédupliquer les points consécutifs identiques
    const uniquePoints = pointsData.filter((pt, i) =>
      i === 0 || pt.lat !== pointsData[i-1].lat || pt.lng !== pointsData[i-1].lng
    );

    // Infos du tour
    const distMatch = pageHtml.match(/"distance"\s*:\s*([\d.]+)/);
    const elevMatch = pageHtml.match(/"elevation_up"\s*:\s*([\d.]+)/);
    const dateMatch = pageHtml.match(/"date"\s*:\s*"([^"]+)"/);

    const distance = distMatch ? (parseFloat(distMatch[1]) / 1000).toFixed(1) : null;
    const elevation = elevMatch ? Math.round(parseFloat(elevMatch[1])) : null;
    const date = dateMatch ? dateMatch[1].split('T')[0] : new Date().toISOString().split('T')[0];

    // Construit le GPX
    let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Trial Tracker" xmlns="http://www.topografix.com/GPX/1/1">
  <metadata><name>${tourName.replace(/[<>&"]/g, '')}</name></metadata>
  <trk>
    <name>${tourName.replace(/[<>&"]/g, '')}</name>
    <trkseg>\n`;

    uniquePoints.forEach(pt => {
      const ele = pt.alt != null ? `\n        <ele>${pt.alt.toFixed(1)}</ele>` : '';
      gpx += `      <trkpt lat="${pt.lat}" lon="${pt.lng}">${ele}\n      </trkpt>\n`;
    });

    gpx += `    </trkseg>\n  </trk>\n</gpx>`;

    console.log(`Komoot import: ${uniquePoints.length} points, "${tourName}"`);

    res.json({ gpx, name: tourName, date, type: 'trail', distance, elevation });

  } catch (e) {
    console.error('Komoot import error:', e);
    res.status(500).json({ error: 'Erreur lors de la récupération : ' + e.message });
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
