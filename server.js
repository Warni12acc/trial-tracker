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
let sessions        = readJSON(SESSIONS_FILE, []);
let activeSession   = readJSON(ACTIVE_FILE, null);
let currentPosition = activeSession ? activeSession.lastPosition || null : null;
let stravaTokens    = readJSON(STRAVA_FILE, null);

// ── Compteur de visiteurs uniques (page famille) ──
let sessionVisitors = new Set(); // IPs uniques, remis à zéro à chaque session

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
//  ROUTES SESSION ACTIVE
// ═══════════════════════════════

// ── Helpers snap-to-route ──
function haversineM(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLng = (b.lng - a.lng) * Math.PI / 180;
  const x = Math.sin(dLat/2)**2 +
    Math.cos(a.lat * Math.PI/180) * Math.cos(b.lat * Math.PI/180) * Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(x), Math.sqrt(1-x));
}

function parseGPXPoints(gpxString) {
  const points = [];
  const regex = /<trkpt[^>]+lat="([\d.-]+)"[^>]+lon="([\d.-]+)"[^>]*>(?:[\s\S]*?<ele>([\d.-]+)<\/ele>)?/g;
  let m;
  while ((m = regex.exec(gpxString)) !== null) {
    points.push({
      lat: parseFloat(m[1]),
      lng: parseFloat(m[2]),
      ele: m[3] ? parseFloat(m[3]) : null
    });
  }
  // Calcule distances cumulées
  let cum = 0;
  return points.map((p, i) => {
    if (i > 0) {
      const prev = points[i-1];
      const R = 6371000;
      const dLat = (p.lat-prev.lat)*Math.PI/180;
      const dLng = (p.lng-prev.lng)*Math.PI/180;
      const a = Math.sin(dLat/2)**2 + Math.cos(prev.lat*Math.PI/180)*Math.cos(p.lat*Math.PI/180)*Math.sin(dLng/2)**2;
      cum += R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
    }
    return { ...p, distM: cum };
  });
}

function findClosestPoint(points, lat, lng) {
  let bestIdx = 0, bestDist = Infinity;
  points.forEach((p, i) => {
    const d = haversineM({ lat, lng }, p);
    if (d < bestDist) { bestDist = d; bestIdx = i; }
  });
  return { idx: bestIdx, distM: bestDist, point: points[bestIdx] };
}

// Pilote : envoie sa position avec snap-to-route
app.post('/api/position', (req, res) => {
  const { lat, lng, timestamp, accuracy } = req.body;

  let snapped = null;
  let distFromRoute = null;
  let distFromStart = null;
  let routeProgress = null;
  let startWarning = false;

  // Si on a un GPX chargé, on fait le snap-to-route
  if (activeSession && activeSession.gpx) {
    const points = parseGPXPoints(activeSession.gpx);

    if (points.length > 1) {
      const totalDistM = points[points.length - 1].distM;

      // Vérifie la proximité du point de départ (< 2km)
      const distToStart = haversineM({ lat, lng }, points[0]);
      const isFirstPosition = !activeSession.breadcrumbs || activeSession.breadcrumbs.length === 0;

      if (isFirstPosition && distToStart > 2000) {
        startWarning = true;
        // On continue quand même mais on avertit
      }

      // Snap to route : trouve le point du tracé le plus proche
      const closest = findClosestPoint(points, lat, lng);
      distFromRoute = Math.round(closest.distM);
      snapped = { lat: closest.point.lat, lng: closest.point.lng, ele: closest.point.ele };
      routeProgress = totalDistM > 0 ? (closest.point.distM / totalDistM) : 0;
      distFromStart = Math.round(closest.point.distM);
    }
  }

  currentPosition = {
    lat, lng,
    snappedLat: snapped?.lat ?? lat,
    snappedLng: snapped?.lng ?? lng,
    snappedEle: snapped?.ele ?? null,
    distFromRoute,
    distFromStart,
    routeProgress,
    timestamp,
    accuracy,
    updatedAt: Date.now(),
    startWarning
  };

  // ── Calcule vitesse et ETA si course démarrée ──
  if (activeSession?.raceInfo?.startTime && distFromStart !== null) {
    const elapsedMs   = Date.now() - activeSession.raceInfo.startTime;
    const elapsedH    = elapsedMs / 3600000;
    const distDoneKm  = distFromStart / 1000;

    // Récupère la distance totale depuis le GPX
    const gpxPts      = parseGPXPoints(activeSession.gpx);
    const totalDistKm = gpxPts.length > 0 ? gpxPts[gpxPts.length - 1].distM / 1000 : null;
    const remainKm    = totalDistKm ? Math.max(0, totalDistKm - distDoneKm) : null;

    // Vitesse moyenne = distance parcourue / temps écoulé (min 50m parcourus)
    const speedKmh = elapsedH > 0 && distDoneKm > 0.05
      ? Math.round((distDoneKm / elapsedH) * 10) / 10
      : null;

    // ETA = heure de DÉPART + (distance totale / vitesse)
    // Formule : tempsTotal = distanceTotale / vitesse → arrivée = départ + tempsTotal
    let etaStr = null;
    if (speedKmh && totalDistKm) {
      const totalTimeH = totalDistKm / speedKmh;           // temps total estimé en heures
      const etaMs      = activeSession.raceInfo.startTime + totalTimeH * 3600000;
      // L'arrivée ne peut pas être avant maintenant
      const etaFinal   = Math.max(etaMs, Date.now() + 60000);
      etaStr = new Date(etaFinal).toLocaleTimeString('fr-FR', { hour:'2-digit', minute:'2-digit' });
    }

    currentPosition.speed  = speedKmh;
    currentPosition.etaStr = etaStr;
  }

  if (activeSession) {
    activeSession.lastPosition = currentPosition;
    if (!activeSession.breadcrumbs) activeSession.breadcrumbs = [];
    activeSession.breadcrumbs.push({
      lat, lng,
      snappedLat: snapped?.lat ?? lat,
      snappedLng: snapped?.lng ?? lng,
      distFromRoute,
      routeProgress,
      timestamp,
      accuracy
    });
    writeJSON(ACTIVE_FILE, activeSession);
  }

  console.log(`Position reçue: ${lat}, ${lng} → snap à ${distFromRoute ?? '?'}m du tracé (${Math.round((routeProgress??0)*100)}%)`);
  res.json({ success: true, snapped, distFromRoute, routeProgress, startWarning });
});

app.get('/api/position', (req, res) => {
  // Compte les visiteurs uniques via IP
  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
  if (ip && ip !== '::1' && ip !== '127.0.0.1') sessionVisitors.add(ip);

  res.json({
    position:      currentPosition,
    sessionActive: !!activeSession,
    breadcrumbs:   activeSession ? activeSession.breadcrumbs || [] : [],
    raceInfo:      activeSession ? activeSession.raceInfo || null : null,
    visitors:      sessionVisitors.size
  });
});

// Pilote : démarre la course (vérifie position < 500m du départ)
app.post('/api/race/start', (req, res) => {
  const { lat, lng } = req.body;
  if (!activeSession || !activeSession.gpx) {
    return res.status(400).json({ error: 'Aucune session active avec GPX' });
  }

  const points = parseGPXPoints(activeSession.gpx);
  if (points.length < 2) return res.status(400).json({ error: 'GPX invalide' });

  // Vérifie position < 500m du départ
  const distToStart = haversineM({ lat, lng }, points[0]);
  if (distToStart > 500) {
    return res.status(400).json({
      error: `Tu es à ${Math.round(distToStart)}m du départ. Rapproche-toi à moins de 500m pour démarrer.`,
      distToStart: Math.round(distToStart)
    });
  }

  // Vérifie que la position n'est pas à plus de 50% du circuit
  const totalDistM = points[points.length-1].distM;
  const closest    = findClosestPoint(points, lat, lng);
  const progress   = closest.point.distM / totalDistM;
  if (progress > 0.5) {
    return res.status(400).json({
      error: `Ta position correspond à ${Math.round(progress*100)}% du parcours. Repars du début.`
    });
  }

  const startTime = Date.now();
  activeSession.raceInfo = {
    startTime,
    startLat: lat,
    startLng: lng
  };
  writeJSON(ACTIVE_FILE, activeSession);

  console.log(`Course démarrée à ${new Date(startTime).toLocaleTimeString('fr-FR')}`);
  res.json({ success: true, startTime });
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
    id:           Date.now().toString(),
    name:         name || 'Sortie sans titre',
    date:         date || new Date().toISOString().split('T')[0],
    type:         type || 'trail',
    gpx:          gpxData,
    startedAt:    Date.now(),
    lastPosition: null,
    breadcrumbs:  [],
    raceInfo:     null
  };
  currentPosition = null;
  sessionVisitors = new Set(); // reset visiteurs
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
