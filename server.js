const express = require('express');
const cors = require('cors');
const path = require('path');
const dns = require('dns').promises;
const PDFDocument = require('pdfkit');
const { execFile } = require('child_process');
const p = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const Tesseract = require('tesseract.js');
p.use(StealthPlugin());

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '.')));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

let browser = null;
async function getBrowser() {
  const isConnected = () => {
    try {
      if (!browser) return false;
      if (typeof browser.connected === 'boolean') return browser.connected;
      if (typeof browser.isConnected === 'function') return browser.isConnected();
      return false;
    } catch { return false; }
  };
  if (!isConnected()) {
    if (browser) { try { await browser.close(); } catch {} }
    browser = await p.launch({
      executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe',
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled']
    });
  }
  return browser;
}

// ── CUIT (via ARCA SETI con puppeteer + OCR, fallback a links) ──
// Shared ARCA lookup function: returns taxpayer data or null
async function consultarArca(cuit) {
  let page = null;
  try {
    const br = await getBrowser();
    page = await br.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.goto('https://seti.afip.gob.ar/padron-puc-constancia-internet/ConsultaConstanciaAction.do', { waitUntil: 'networkidle2', timeout: 20000 });
    await new Promise(r => setTimeout(r, 2000));

    const frames = page.frames();
    for (const f of frames) {
      try {
        const ftext = await f.evaluate(() => document.body?.innerText || '').catch(() => '');
        if (!ftext.includes('CUIT del Contribuyente')) continue;

        for (let attempt = 0; attempt < 6; attempt++) {
          await f.evaluate(() => { document.querySelector('.ag-captcha-btn')?.click(); });
          await new Promise(r => setTimeout(r, 2000));

          const formData = await f.evaluate(() => {
            const img = document.getElementById('imgCaptcha');
            return {
              captchaB64: img ? img.src : null,
              tokenCaptcha: document.getElementById('tokenCaptcha')?.value || '',
              bar: document.getElementById('bar')?.value || '',
              miContexto: document.getElementById('miContexto')?.value || ''
            };
          });

          if (!formData.captchaB64 || !formData.captchaB64.startsWith('data:image')) continue;

          const base64Data = formData.captchaB64.split(',')[1];
          const ocr = await Tesseract.recognize(Buffer.from(base64Data, 'base64'), 'eng', { logger: () => {} });
          const raw = ocr.data.text;
          const cleaned = raw.replace(/[^a-zA-Z0-9]/g, '').substring(0, 6);
          
          if (cleaned.length !== 6) continue;

          const postUrl = 'https://seti.afip.gob.ar' + formData.miContexto + '/ConstanciaAction.do?bar=' + formData.bar;
          const body = JSON.stringify({ data: JSON.stringify({ cuit, txtSolucion: cleaned, txtToken: formData.tokenCaptcha, systemId: 'constanciaPadron' }) });

          const postRes = await page.evaluate(async (url, b) => {
            try {
              const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: b });
              return { status: r.status, text: await r.text() };
            } catch(e) { return { error: e.message }; }
          }, postUrl, body);

          if (!postRes.text) continue;
          let parsed;
          try { parsed = JSON.parse(postRes.text); } catch(e) { continue; }
          if (!parsed.redirect) continue;
          if (parsed.redirect.includes('invalido')) continue;
          if (parsed.redirect.includes('contribuyente')) return null;

          const resultUrl = new URL(parsed.redirect, 'https://seti.afip.gob.ar/padron-puc-constancia-internet/').href;
          const resultData = await page.evaluate(async (url) => {
            try { const r = await fetch(url); return await r.text(); } catch(e) { return null; }
          }, resultUrl);

          if (resultData) {
            const result = { cuit };
            const rows = resultData.match(/<tr[^>]*>[\s\S]*?<\/tr>/g) || [];
            for (const row of rows) {
              const cells = row.match(/<td[^>]*>([\s\S]*?)<\/td>/g) || [];
              if (cells.length >= 2) {
                const key = cells[0].replace(/<[^>]+>/g, '').trim();
                const val = cells[1].replace(/<[^>]+>/g, '').trim();
                if (key && val) result[key] = val;
              }
            }
            const paragraphs = resultData.match(/<p[^>]*>([\s\S]*?)<\/p>/g) || [];
            for (const p of paragraphs) {
              const text = p.replace(/<[^>]+>/g, '').trim();
              if (text.includes(':') && !text.includes('Si desea')) {
                const parts = text.split(':');
                if (parts.length >= 2) result[parts[0].trim()] = parts.slice(1).join(':').trim();
              }
            }
            result.fuente = 'ARCA';
            return result;
          }
        }
        break;
      } catch(e) { /* continue to next frame */ }
    }
    return null;
  } catch (e) { return null; }
  finally { if (page) await page.close().catch(() => {}); }
}

app.get('/api/cuit/:cuit', async (req, res) => {
  const cuit = req.params.cuit.replace(/\D/g, '');
  if (cuit.length !== 11) return res.json({ error: 'CUIT debe tener 11 digitos', cuit, links: { cuitonline: 'https://www.cuitonline.com/search.php?q=' + cuit } });
  try {
    const data = await consultarArca(cuit);
    if (data) return res.json(data);
    res.json({ error: 'No se pudo consultar ARCA automaticamente. Abri estos enlaces manualmente.', cuit, links: { cuitonline: 'https://www.cuitonline.com/detalle/' + cuit + '.html', dateas: 'https://www.dateas.com/es/consulta_cuit_cuil/' + cuit } });
  } catch (e) {
    res.json({ error: 'Error: ' + e.message, cuit, links: { cuitonline: 'https://www.cuitonline.com/detalle/' + cuit + '.html' } });
  }
});

app.get('/api/dominio/:email', async (req, res) => {
  try {
    const domain = req.params.email.split('@')[1];
    if (!domain) return res.json({ error: 'Email invalido' });
    const [mx, a, txt] = await Promise.allSettled([dns.resolveMx(domain), dns.resolve4(domain), dns.resolveTxt(domain)]);
    const mxRecords = mx.status === 'fulfilled' ? mx.value.sort((a,b) => a.priority - b.priority).map(m => ({ priority: m.priority, exchange: m.exchange })) : [];
    const ip = a.status === 'fulfilled' ? a.value[0] : null;
    const spf = txt.status === 'fulfilled' ? txt.value.flat().find(t => t.startsWith('v=spf1')) || null : null;
    res.json({ dominio: domain, mx: mxRecords.length ? mxRecords[0].exchange : null, ip, spf, mxCount: mxRecords.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/holehe/:email', async (req, res) => {
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile('python', [path.join(__dirname, 'holehe_wrapper.py'), req.params.email, '70'], { timeout: 75000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) { reject(err); return; }
        resolve(stdout || '');
      });
    });
    res.json(JSON.parse(stdout));
  } catch (e) { res.json({ email: req.params.email, error: e.message, resultados: [], total: 0 }); }
});

app.get('/api/wayback/:dominio', async (req, res) => {
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile('python', [path.join(__dirname, 'wayback_wrapper.py'), req.params.dominio], { timeout: 20000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) { reject(err); return; }
        resolve(stdout || '');
      });
    });
    res.json(JSON.parse(stdout));
  } catch (e) { res.json({ dominio: req.params.dominio, error: e.message }); }
});

const SITES = [
  { nombre: 'GitHub', url: u => 'https://github.com/' + u, deleteUrl: 'https://github.com/settings/admin' },
  { nombre: 'Twitter/X', url: u => 'https://x.com/' + u, deleteUrl: 'https://x.com/settings/deactivate' },
  { nombre: 'Instagram', url: u => 'https://instagram.com/' + u, deleteUrl: 'https://www.instagram.com/accounts/remove/request/permanent/' },
  { nombre: 'Reddit', url: u => 'https://reddit.com/user/' + u, deleteUrl: 'https://www.reddit.com/settings/delete' },
  { nombre: 'TikTok', url: u => 'https://tiktok.com/@' + u, deleteUrl: 'https://www.tiktok.com/setting/deactivate' },
  { nombre: 'Telegram', url: u => 'https://t.me/' + u, deleteUrl: '' },
  { nombre: 'YouTube', url: u => 'https://youtube.com/@' + u, deleteUrl: 'https://www.youtube.com/account_advanced' },
  { nombre: 'Facebook', url: u => 'https://facebook.com/' + u, deleteUrl: 'https://www.facebook.com/settings?tab=deactivation_and_deletion' },
  { nombre: 'Twitch', url: u => 'https://twitch.tv/' + u, deleteUrl: 'https://www.twitch.tv/settings/security' }
];
app.get('/api/usuario/:user', async (req, res) => {
  const user = req.params.user;
  const results = [];
  for (const site of SITES) {
    try {
      const r = await fetch(site.url(user), { method: 'HEAD', signal: AbortSignal.timeout(5000) });
      const existe = r.ok || r.status === 403 || r.status === 429;
      results.push({ nombre: site.nombre, existe, url: site.url(user), deleteUrl: site.deleteUrl, status: r.status });
    } catch {
      results.push({ nombre: site.nombre, existe: false, url: site.url(user), deleteUrl: site.deleteUrl, status: 0 });
    }
  }
  res.json({ usuario: user, resultados: results });
});

app.get('/api/sherlock/:user', async (req, res) => {
  const user = req.params.user;
  try {
    const stdout = await new Promise((resolve, reject) => {
      execFile('python', [path.join(__dirname, 'sherlock_wrapper.py'), user, '100'], { timeout: 110000, maxBuffer: 1024 * 1024 }, (err, stdout) => {
        if (err && !stdout) { reject(err); return; }
        resolve(stdout || '');
      });
    });
    const parsed = JSON.parse(stdout);
    res.json(parsed);
  } catch (e) {
    res.json({ usuario: user, error: e.message, resultados: [], total: 0 });
  }
});

app.get('/api/phonecheck/:numero', async (req, res) => {
  const limpio = req.params.numero.replace(/\D/g, '');
  const e164 = '+' + (limpio.startsWith('54') ? '' : '54') + limpio.replace(/^0+/, '');
  const resultados = [];

  const servicios = [
    { nombre: 'WhatsApp', url: 'https://wa.me/' + e164, check: async () => {
      try { const r = await fetch('https://wa.me/' + e164, { signal: AbortSignal.timeout(8000), redirect: 'manual' }); return r.ok; } catch { return false; } }},
    { nombre: 'Telegram', url: 'https://t.me/+' + e164, check: async () => {
      try { const r = await fetch('https://t.me/+' + e164.replace('+',''), { signal: AbortSignal.timeout(8000) }); return r.ok; } catch { return false; } }},
    { nombre: 'Signal', url: 'https://signal.me/#p/' + e164 },
    { nombre: 'Viber', url: 'https://viber.click/' + e164.replace('+','') },
    { nombre: 'Truecaller', url: 'https://www.truecaller.com/search/in/' + e164.replace('+','') },
    { nombre: 'Tellows', url: 'https://www.tellows.com/num/' + e164.replace('+','') },
    { nombre: 'SpyDialer', url: 'https://www.spydialer.com/default.aspx?search=' + e164.replace('+','') },
  ];

  for (const s of servicios) {
    let disponible = false;
    if (s.check) { try { disponible = await s.check(); } catch {} }
    resultados.push({ nombre: s.nombre, disponible, url: s.url, automatico: !!s.check });
  }

  const carrier = limpio.length >= 11 ? (
    limpio.startsWith('54911') ? 'CLARO' :
    limpio.startsWith('54915') || limpio.startsWith('549351') ? 'MOVISTAR' :
    limpio.startsWith('54923') || limpio.startsWith('54922') ? 'PERSONAL' :
    limpio.startsWith('54933') ? 'TUENTI' : 'CLARO / MOVISTAR / PERSONAL'
  ) : '-';

  res.json({ numero: req.params.numero, e164, carrier, resultados });
});

app.get('/api/ddjj/:nombre', async (req, res) => {
  try {
    const nombre = req.params.nombre.trim();
    // Main resource: DDJJ Patrimoniales Integrales 2024 (the only one in datastore)
    const resourceId = 'a331ccb8-5c13-447f-9bd6-d8018a4b8a62';
    const r = await fetch('https://datos.jus.gob.ar/api/3/action/datastore_search?resource_id=' + resourceId + '&q=' + encodeURIComponent(nombre) + '&limit=30', { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'OSINT-Dashboard/1.0' } });
    const rd = await r.json();
    const records = (rd.success && rd.result && rd.result.records) ? rd.result.records : [];
    if (!records.length) return res.json({ nombre, encontrado: false, mensaje: 'No se encontraron declaraciones juradas para "' + nombre + '"', fuente: 'https://datos.jus.gob.ar/dataset/declaraciones-juradas-patrimoniales-integrales' });
    const resultados = records.map(r => ({
      funcionario: r.funcionario_apellido_nombre || 'N/D',
      cuit: r.cuit || 'N/D',
      cargo: r.cargo && r.cargo !== '0.00' ? r.cargo : 'No especificado',
      organismo: r.organismo && r.organismo !== '0.00' ? r.organismo : 'No especificado',
      anio: r.anio || 'N/D',
      tipo: r.tipo_declaracion_jurada_descripcion || 'N/D',
      sector: r.sector || 'N/D'
    }));
    res.json({ nombre, encontrado: true, total: resultados.length, resultados, fuente: 'https://datos.jus.gob.ar/dataset/declaraciones-juradas-patrimoniales-integrales' });
  } catch (e) { res.json({ error: e.message, nombre: req.params.nombre }); }
});

app.get('/api/bcra/:cuit', async (req, res) => {
  try {
    const cuit = req.params.cuit.replace(/\D/g, '');
    if (cuit.length !== 11) return res.json({ error: 'CUIT debe tener 11 digitos', cuit });
    const r = await fetch('https://api.bcra.gob.ar/CentralDeDeudores/v1.0/Deudas/' + cuit, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'OSINT-Dashboard/1.0', 'Accept': 'application/json' } });
    if (r.status === 404) return res.json({ cuit, encontrado: false, mensaje: 'Sin deudas registradas en el BCRA' });
    const data = await r.json();
    const periodos = (data.results && data.results.periodos) || [];
    // Extract titular info (nombre/apellido/razon social)
    const nombre = (data.results && (data.results.denominacion || data.results.nombre || '')) || '';

    if (!periodos.length) {
      const resp = { cuit, encontrado: false, mensaje: 'Sin informacion crediticia en el BCRA' };
      if (nombre) resp.nombre = nombre;
      return res.json(resp);
    }
    const ultimo = periodos[0];
    const sitMap = { 1: 'Normal', 2: 'Riesgo bajo', 3: 'Riesgo medio', 4: 'Riesgo alto', 5: 'Irrecuperable', 6: 'Irrecuperable por disposicion' };
    let sitMax = 1;
    const entidades = (ultimo.entidades || []).map(e => {
      if (e.situacion > sitMax) sitMax = e.situacion;
      return { entidad: e.entidad, situacion: e.situacion, descripcion: sitMap[e.situacion] || 'Codigo ' + e.situacion, monto: e.monto };
    });
    const resp = { cuit, encontrado: true, periodo: ultimo.periodo, situacion_maxima: sitMax, situacion_descripcion: sitMap[sitMax] || 'Codigo ' + sitMax, entidades, fuente: 'https://www.bcra.gob.ar/BCRAyVos/Situacion_Crediticia.asp' };
    if (nombre) resp.nombre = nombre;
    res.json(resp);
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/ct/:domain', async (req, res) => {
  try {
    const domain = req.params.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    // Try crt.sh first (certificate transparency logs)
    const r = await fetch('https://crt.sh/?q=%25.' + domain + '&output=json&excluded=expired', { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'OSINT-Dashboard/1.0' } });
    if (r.ok) {
      const data = await r.json();
      if (Array.isArray(data) && data.length) {
        const unicos = [...new Set(data.map(e => e.name_value).join('\n').split('\n'))].filter(n => n.endsWith('.' + domain) || n === domain).sort();
        if (unicos.length) return res.json({ domain, total: unicos.length, subdominios: unicos.slice(0, 100), fuente: 'https://crt.sh' });
      }
    }
    // Fallback: hackertarget hostsearch (free, no key)
    const r2 = await fetch('https://api.hackertarget.com/hostsearch/?q=' + domain, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'OSINT-Dashboard/1.0' } });
    if (!r2.ok) return res.json({ domain, total: 0, subdominios: [], fuente: 'api.hackertarget.com' });
    const text = await r2.text();
    const lines = text.split('\n').filter(Boolean);
    const unicos2 = [...new Set(lines.map(l => l.split(',')[0]).filter(Boolean))].filter(n => n.endsWith('.' + domain) || n === domain).sort();
    if (!unicos2.length) return res.json({ domain, total: 0, subdominios: [], fuente: 'api.hackertarget.com' });
    res.json({ domain, total: unicos2.length, subdominios: unicos2.slice(0, 100), fuente: 'api.hackertarget.com' });
  } catch (e) { res.json({ error: e.message, domain: req.params.domain }); }
});

app.get('/api/breach/:email', async (req, res) => {
  try {
    const email = req.params.email.toLowerCase();
    const r = await fetch('https://leakcheck.net/api/public?check=' + encodeURIComponent(email), { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'OSINT-Dashboard/1.0', 'Accept': 'application/json' } });
    if (!r.ok) return res.json({ email, encontrado: false, mensaje: 'Error al consultar leakcheck.net' });
    const data = await r.json();
    if (!data || !data.success || !data.found) return res.json({ email, encontrado: false, mensaje: 'No aparece en breaches conocidos' });
    const fuentes = Array.isArray(data.sources) ? data.sources.map(s => s.name || s) : [];
    const campos = Array.isArray(data.fields) ? data.fields : [];
    res.json({
      email, encontrado: true, total: data.found,
      campos_expuestos: campos,
      fuentes,
      fuente: 'https://leakcheck.net'
    });
  } catch (e) { res.json({ error: e.message, email: req.params.email }); }
});

app.get('/api/bin/:bin', async (req, res) => {
  try {
    const bin = req.params.bin.replace(/\D/g, '').slice(0, 8);
    if (bin.length < 6) return res.json({ error: 'BIN debe tener al menos 6 digitos', bin });
    const r = await fetch('https://lookup.binlist.net/' + bin, { signal: AbortSignal.timeout(8000), headers: { 'Accept-Version': '3', 'User-Agent': 'OSINT-Dashboard/1.0' } });
    if (r.status === 404) return res.json({ bin, encontrado: false, mensaje: 'BIN no encontrado' });
    const data = await r.json();
    res.json({ bin, encontrado: true, esquema: data.scheme || 'N/D', tipo: data.type || 'N/D', marca: data.brand || 'N/D', banco: (data.bank || {}).name || 'N/D', pais: (data.country || {}).name || 'N/D', moneda: (data.country || {}).currency || 'N/D', prepago: data.prepaid || false, luhn: data.luhn || false, fuente: 'https://binlist.net' });
  } catch (e) { res.json({ error: e.message, bin: req.params.bin }); }
});

app.get('/api/crypto/:address', async (req, res) => {
  try {
    const addr = req.params.address.trim();
    if (addr.startsWith('1') || addr.startsWith('3') || addr.startsWith('bc1')) {
      const r = await fetch('https://blockchain.info/rawaddr/' + addr + '?limit=10', { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'OSINT-Dashboard/1.0' } });
      if (!r.ok) return res.json({ address: addr, tipo: 'BTC', error: 'No se pudo consultar blockchain.info' });
      const data = await r.json();
      res.json({ address: addr, tipo: 'BTC', encontrado: true, total_tx: data.n_tx, total_recibido: data.total_received / 1e8 + ' BTC', total_enviado: data.total_sent / 1e8 + ' BTC', saldo: data.final_balance / 1e8 + ' BTC', transacciones: (data.txs || []).slice(0, 5).map(t => ({ hash: t.hash, total: t.result / 1e8 + ' BTC', fecha: new Date(t.time * 1000).toISOString().split('T')[0] })), fuente: 'https://blockchain.info' });
    } else if (addr.startsWith('0x')) {
      const r = await fetch('https://api.etherscan.io/api?module=account&action=txlist&address=' + addr + '&startblock=0&endblock=99999999&sort=desc&apikey=YourApiKeyToken', { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'OSINT-Dashboard/1.0' } });
      if (!r.ok) return res.json({ address: addr, tipo: 'ETH', error: 'No se pudo consultar Etherscan' });
      const data = await r.json();
      if (data.status !== '1') return res.json({ address: addr, tipo: 'ETH', encontrado: false, mensaje: 'Sin transacciones o direccion invalida' });
      res.json({ address: addr, tipo: 'ETH', encontrado: true, total_tx: (data.result || []).length, transacciones: (data.result || []).slice(0, 5).map(t => ({ hash: t.hash, desde: t.from, hasta: t.to, valor: (t.value / 1e18).toFixed(6) + ' ETH', fecha: new Date(parseInt(t.timeStamp) * 1000).toISOString().split('T')[0] })), fuente: 'https://etherscan.io' });
    } else {
      res.json({ address: addr, encontrado: false, mensaje: 'Direccion no reconocida. Usa direccion BTC (1, 3, bc1...) o ETH (0x...)' });
    }
  } catch (e) { res.json({ error: e.message, address: req.params.address }); }
});

app.get('/api/whois/:domain', async (req, res) => {
  try {
    const domain = req.params.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    // Try RDAP (free, no key) first, fallback to who-dat
    let rdapUrl = domain.endsWith('.ar') ? 'https://rdap.nic.ar/domain/' + domain :
                  domain.endsWith('.com') ? 'https://rdap.verisign.com/com/v1/domain/' + domain :
                  'https://rdap.verisign.com/com/v1/domain/' + domain;
    // Use who-dat as it's simpler and free
    const r = await fetch('https://who-dat.as93.net/' + domain, { signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'OSINT-Dashboard/1.0' } });
    if (!r.ok) return res.json({ domain, encontrado: false, mensaje: 'No se pudo obtener WHOIS' });
    const data = await r.json();
    res.json({
      domain, encontrado: true,
      registrar: data.registrar || data.Registrar || 'N/D',
      creado: data.creation_date || data.created || data.CreationDate || 'N/D',
      expira: data.expiration_date || data.expires || data.ExpirationDate || 'N/D',
      actualizado: data.updated_date || data.updated || data.UpdatedDate || 'N/D',
      nameservers: Array.isArray(data.name_servers || data.nameservers) ? (data.name_servers || data.nameservers).slice(0, 6) : (data.name_servers || data.nameservers || 'N/D'),
      organizacion: data.org || data.organization || data.OrgName || 'N/D',
      pais: data.country || data.Country || 'N/D',
      estado: data.status || data.Status || 'N/D',
      emails: data.emails || data.registrant_emails || [],
      fuente: 'https://who-dat.as93.net'
    });
  } catch (e) { res.json({ error: e.message, domain: req.params.domain }); }
});

app.get('/api/dorks/:target', (req, res) => {
  const target = req.params.target;
  const templates = [
    '"{target}"', '"{target}" site:linkedin.com', '"{target}" site:twitter.com',
    '"{target}" site:facebook.com', '"{target}" site:instagram.com', '"{target}" site:github.com',
    '"{target}" filetype:pdf', '"{target}" inurl:profile', '"{target}" resume OR cv',
    '"{target}" leaked OR breach OR dump', 'intitle:"{target}"',
    '"{target}" -site:linkedin.com -site:facebook.com',
  ];
  const dorks = templates.map(t => {
    const q = t.replace(/{target}/g, target);
    return { dork: q, url: 'https://www.google.com/search?q=' + encodeURIComponent(q) };
  });
  res.json({ target, total: dorks.length, dorks, fuente: 'OpenOSINT generate_dorks' });
});

app.get('/api/paste/:query', (req, res) => {
  const query = req.params.query;
  // Generate search URLs for multiple paste sites (free, no API key)
  const resultados = [
    { sitio: 'Pastebin', url: 'https://pastebin.com/search?q=' + encodeURIComponent(query), desc: 'Buscar en pastebin.com' },
    { sitio: 'Google (site:pastebin)', url: 'https://www.google.com/search?q=' + encodeURIComponent('site:pastebin.com "' + query + '"'), desc: 'Google search en Pastebin' },
    { sitio: 'Google (site:pastie)', url: 'https://www.google.com/search?q=' + encodeURIComponent('site:pastie.org "' + query + '"'), desc: 'Google search en Pastie' },
    { sitio: 'Google (site:ghostbin)', url: 'https://www.google.com/search?q=' + encodeURIComponent('site:ghostbin.com "' + query + '"'), desc: 'Google search en Ghostbin' },
    { sitio: 'LeakCheck', url: 'https://leakcheck.net/', desc: 'Buscar en LeakCheck (breaches)' },
    { sitio: 'Google dorks', url: 'https://www.google.com/search?q=' + encodeURIComponent('"' + query + '" leaked OR breach OR dump'), desc: 'Google dork general' },
  ];
  res.json({ query, encontrado: true, total: resultados.length, resultados, fuente: 'OpenOSINT search_paste' });
});

app.get('/api/dnsdeep/:domain', async (req, res) => {
  try {
    const domain = req.params.domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase().replace(/\.$/, '');
    if (!domain) return res.json({ error: 'Dominio invalido' });
    const dns = require('dns');
    const p4 = () => new Promise(r => dns.resolve4(domain, (e, v) => r(e ? [] : v)));
    const p6 = () => new Promise(r => dns.resolve6(domain, (e, v) => r(e ? [] : v)));
    const pMx = () => new Promise(r => dns.resolveMx(domain, (e, v) => r(e ? [] : (v || []).map(m => m.exchange + ' (priority ' + m.priority + ')'))));
    const pNs = () => new Promise(r => dns.resolveNs(domain, (e, v) => r(e ? [] : v)));
    const pTxt = (name) => new Promise(r => dns.resolveTxt(name, (e, v) => r(e ? [] : (v || []).flat())));
    const pCname = () => new Promise(r => dns.resolveCname(domain, (e, v) => r(e ? [] : v)));
    const pSoa = () => new Promise(r => dns.resolveSoa(domain, (e, v) => r(e ? null : (v.nsname || ''))));
    const [a, aaaa, mx, ns, txt, cname, soa, dmarc] = await Promise.all([
      p4(), p6(), pMx(), pNs(), pTxt(domain), pCname(), pSoa(), pTxt('_dmarc.' + domain),
    ]);
    const spf = (txt || []).find(t => t.startsWith('v=spf1')) || null;
    const spfWarnings = spf ? (spf.includes('+all') ? ['SPF permite +all — cualquiera puede enviar email como el dominio'] : spf.includes('~all') ? ['SPF usa ~all (soft fail)'] : []) : ['No hay registro SPF — cualquiera puede spoofear el dominio'];
    const dmarcRecord = dmarc && dmarc.length ? dmarc[0] : null;
    const dmarcWarnings = dmarcRecord ? (dmarcRecord.includes('p=none') ? ['DMARC p=none — solo monitoreo, no bloquea'] : []) : ['No hay DMARC — no se validan fallos SPF/DKIM'];
    const dkimSelectors = ['default', 'google', 'mail', 'dkim', 's1', 's2', 'selector1', 'selector2', 'k1'];
    const dkimResults = [];
    for (const sel of dkimSelectors) {
      try { const r = await new Promise(res => dns.resolveTxt(sel + '._domainkey.' + domain, (e, v) => res(e ? null : v))); if (r && r.length) { dkimResults.push(sel + ': ' + r.flat().join(' ').slice(0, 80)); } } catch {}
    }
    res.json({
      domain, records: { a, aaaa, mx, ns, txt, cname, soa },
      email_security: { spf, spfWarnings, dmarc: dmarcRecord, dmarcWarnings, dkim: dkimResults.length ? dkimResults : ['No se encontraron registros DKIM para selectores comunes'] },
      fuente: 'OpenOSINT search_dns'
    });
  } catch (e) { res.json({ error: e.message, domain: req.params.domain }); }
});

app.get('/api/emailfinder/:domain', async (req, res) => {
  const domain = req.params.domain.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  const resultados = [];

  // Google dorks
  const dorks = [
    `"@${domain}"`,
    `site:${domain} email`,
    `site:${domain} "@${domain}"`,
    `site:${domain} contact`,
    `site:${domain} "mailto:"`,
    `"${domain}" filetype:csv email`,
    `"${domain}" "correo" OR "email"`,
  ];
  for (const d of dorks) {
    resultados.push({ metodo: 'Google Dork', dork: d, url: 'https://www.google.com/search?q=' + encodeURIComponent(d) });
  }

  // Free public sources
  resultados.push({ metodo: 'Skymem', url: 'https://www.skymem.info/srch?q=' + encodeURIComponent(domain), desc: 'Base de emails publicos' });
  resultados.push({ metodo: 'Hunter.io', url: 'https://hunter.io/search/' + encodeURIComponent(domain), desc: 'Requiere clave API (gratis 25/mes)' });
  resultados.push({ metodo: 'Snov.io', url: 'https://snov.io/email-finder?domain=' + encodeURIComponent(domain), desc: 'Requiere registro gratis' });
  resultados.push({ metodo: 'Phonebook.cz', url: 'https://phonebook.cz/?domain=' + encodeURIComponent(domain), desc: 'Busqueda de dominios (InteligenceX)' });
  resultados.push({ metodo: 'Pastebin', url: 'https://pastebin.com/search?q=' + encodeURIComponent('@' + domain), desc: 'Filtraciones en Pastebin' });
  resultados.push({ metodo: 'GitHub', url: 'https://github.com/search?q=' + encodeURIComponent('"' + '@' + domain + '"') + '&type=code', desc: 'Codigo fuente en GitHub' });

  // Try to resolve MX records to confirm domain (with timeout)
  let mxRecords = [];
  try {
    const mx = await Promise.race([
      dns.resolveMx(domain),
      new Promise((_, reject) => setTimeout(() => reject(new Error('MX timeout')), 5000))
    ]);
    mxRecords = mx.map(m => m.exchange);
  } catch {}

  res.json({ domain, total: resultados.length, resultados, mx: mxRecords, fuente: 'EmailFinder' });
});

app.get('/api/rns/:query', async (req, res) => {
  const query = req.params.query.trim();
  const tipo = req.query.tipo || 'cuit'; // 'cuit' or 'razon'
  const resultados = [];

  // 1. Generate search URLs for official government page
  resultados.push({ metodo: 'Argentina.gob.ar', url: 'https://www.argentina.gob.ar/justicia/registro-nacional-sociedades', desc: 'Buscar en el sitio oficial (requiere captcha)' });
  resultados.push({ metodo: 'CUIT Online', url: 'https://www.cuitonline.com/search.php?q=' + encodeURIComponent(query), desc: 'Buscar en cuitonline.com' });
  resultados.push({ metodo: 'Dateas', url: 'https://www.dateas.com/es/consulta_cuit_cuil/' + encodeURIComponent(query), desc: 'Buscar en Dateas' });

  // 2. Query CKAN DataStore sample data
  let ckanResults = [];
  try {
    const filter = tipo === 'cuit'
      ? JSON.stringify({ cuit: query })
      : JSON.stringify({ razon_social: query });
    const ckanUrl = 'https://datos.jus.gob.ar/api/3/action/datastore_search?resource_id=6096331b-0511-4728-b01b-6c6b535f4c2b&filters=' + encodeURIComponent(filter);
    const r = await fetch(ckanUrl, { signal: AbortSignal.timeout(8000) });
    const data = await r.json();
    if (data.success && data.result && data.result.records) {
      ckanResults = data.result.records;
    }
  } catch {}

  // 3. Fallback: use full-text search if filter returned nothing
  if (ckanResults.length === 0) {
    try {
      const ckanUrl2 = 'https://datos.jus.gob.ar/api/3/action/datastore_search?resource_id=6096331b-0511-4728-b01b-6c6b535f4c2b&q=' + encodeURIComponent(query);
      const r2 = await fetch(ckanUrl2, { signal: AbortSignal.timeout(8000) });
      const data2 = await r2.json();
      if (data2.success && data2.result && data2.result.records) {
        ckanResults = data2.result.records;
      }
    } catch {}
  }

  res.json({ query, tipo, encontrado: ckanResults.length > 0, total_ckan: ckanResults.length, resultados, ckan: ckanResults.slice(0, 20), fuente: 'datos.jus.gob.ar + Argentina.gob.ar' });
});

app.get('/api/ip/:ip', async (req, res) => {
  try {
    const ip = req.params.ip;
    const r = await fetch('http://ip-api.com/json/' + ip + '?fields=status,message,country,regionName,city,zip,lat,lon,isp,org,as,query,timezone,mobile,proxy,hosting');
    const data = await r.json();
    if (data.status === 'success') {
      let hostname = '';
      try { const hosts = await dns.reverse(ip); hostname = hosts[0] || ''; } catch {}
      data.hostname = hostname;
    }
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/project-pdf', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { title, items } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: 'No hay datos para el informe' });

    const doc = new PDFDocument({ margin: 40, size: 'A4' });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="informe-osint.pdf"');
    doc.pipe(res);

    // Compact header
    doc.fontSize(9).font('Helvetica-Bold').fillColor('#1a1a2e').text('INFORME OSINT · ' + (title || 'Sin titulo'), { continued: false });
    doc.fontSize(7).fillColor('#888').text('Generado: ' + new Date().toLocaleString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' }), { continued: false });
    doc.moveDown(0.8);

    // Items (continuos, no page breaks between)
    for (let i = 0; i < items.length; i++) {
      const item = items[i];

      // Check if we need a new page (estimate content height)
      const estLines = ((item.content || '').length / 80) + 3;
      if (doc.y + estLines * 10 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
      }

      // Compact item header
      doc.fontSize(8).font('Helvetica-Bold').fillColor('#1a1a2e').text((item.tool || 'Resultado') + '  |  ' + (item.timestamp || ''), { continued: false });
      doc.moveDown(0.3);

      // Content compact (smaller font, no indent)
      doc.fontSize(7).font('Helvetica').fillColor('#333');
      const content = (item.content || 'Sin datos');
      doc.text(content, { indent: 0, lineGap: 1 });

      doc.moveDown(0.4);
    }

    // Footer
    doc.moveDown(0.5);
    doc.fontSize(7).fillColor('#999').text('OSINT Dashboard · Fuentes de informacion publica', { align: 'center' });

    doc.end();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/project-save', express.json({ limit: '10mb' }), (req, res) => {
  try {
    const { title, items } = req.body;
    const fs = require('fs');
    const filename = 'proyecto_' + (title || 'sin_titulo').replace(/[^a-zA-Z0-9_\-]/g, '_') + '_' + Date.now() + '.json';
    const dir = path.join(__dirname, 'proyectos');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, filename), JSON.stringify({ title, items, fecha: new Date().toISOString() }, null, 2), 'utf8');
    res.json({ success: true, archivo: filename });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// === Nmap (port scan via Node.js net, con fallback a nmap si instalado) ===
const commonPorts = [
  { port: 21, name: 'FTP' }, { port: 22, name: 'SSH' }, { port: 23, name: 'Telnet' },
  { port: 25, name: 'SMTP' }, { port: 53, name: 'DNS' }, { port: 80, name: 'HTTP' },
  { port: 110, name: 'POP3' }, { port: 143, name: 'IMAP' }, { port: 443, name: 'HTTPS' },
  { port: 445, name: 'SMB' }, { port: 465, name: 'SMTPS' }, { port: 587, name: 'SMTP-sub' },
  { port: 993, name: 'IMAPS' }, { port: 995, name: 'POP3S' }, { port: 1433, name: 'MSSQL' },
  { port: 1521, name: 'Oracle' }, { port: 2049, name: 'NFS' }, { port: 3306, name: 'MySQL' },
  { port: 3389, name: 'RDP' }, { port: 5432, name: 'PostgreSQL' }, { port: 5900, name: 'VNC' },
  { port: 5985, name: 'WinRM-HTTP' }, { port: 5986, name: 'WinRM-HTTPS' },
  { port: 6379, name: 'Redis' }, { port: 8080, name: 'HTTP-proxy' },
  { port: 8443, name: 'HTTPS-alt' }, { port: 9090, name: 'HTTP-alt' },
  { port: 27017, name: 'MongoDB' }
];
const servicePorts = commonPorts.reduce((a, p) => { a[p.port] = p.name; return a; }, {});

function scanPort(host, port, timeout) {
  return new Promise((resolve) => {
    const s = new (require('net').Socket)();
    s.setTimeout(timeout || 2000);
    s.on('connect', () => { s.destroy(); resolve({ port, state: 'open', service: servicePorts[port] || 'unknown' }); });
    s.on('timeout', () => { s.destroy(); resolve({ port, state: 'filtered', service: servicePorts[port] || 'unknown' }); });
    s.on('error', () => { s.destroy(); resolve({ port, state: 'filtered', service: servicePorts[port] || 'unknown' }); });
    s.connect(port, host);
  });
}

app.get('/api/nmap/:target', async (req, res) => {
  try {
    const target = req.params.target;
    const flags = req.query.flags || '--fast';
    if (!target) return res.json({ error: 'Especifica un target (IP o dominio)' });

    // Resolve hostname to IP
    let ip = target;
    try {
      const { Resolver } = require('dns').promises;
      const resolver = new Resolver();
      const addrs = await resolver.resolve4(target);
      if (addrs && addrs.length > 0) ip = addrs[0];
    } catch(e) { /* usar target como IP */ }

    // Try nmap first
    const { execFile } = require('child_process');
    let nmapResult = null;
    try {
      const nmapOut = await new Promise((resolve, reject) => {
        execFile('nmap', ['-sS', '-sV', '-T4', '--open', '-oX', '-', target], { timeout: 120000 }, (err, stdout) => {
          if (err && err.code === 'ENOENT') { resolve(null); return; }
          if (err) { resolve(null); return; }
          resolve(stdout);
        });
      });
      if (nmapOut) {
        const parseXml = (xml) => {
          const hosts = []; const re = /<host[^>]*>[\s\S]*?<\/host>/g; let m;
          while ((m = re.exec(xml)) !== null) {
            const h = m[0]; const host = {};
            const a = h.match(/<address addr="([^"]+)"/); if (a) host.ip = a[1];
            const hn = h.match(/<hostname name="([^"]+)"/); if (hn) host.hostname = hn[1];
            const ports = []; const pr = /<port[^>]*>[\s\S]*?<\/port>/g; let pm;
            while ((pm = pr.exec(h)) !== null) {
              const p = pm[0]; const pn = p.match(/portid="(\d+)"/);
              const st = p.match(/<state state="([^"]+)"/);
              const sv = p.match(/<service name="([^"]+)"/); const pd = p.match(/product="([^"]+)"/); const pv = p.match(/version="([^"]+)"/);
              if (pn) ports.push({ port: parseInt(pn[1]), state: st ? st[1] : 'unknown', service: sv ? sv[1] : '', product: pd ? pd[1] : '', version: pv ? pv[1] : '' });
            }
            host.ports = ports;
            const os = h.match(/<osmatch[^>]*name="([^"]+)"/); if (os) host.os = os[1];
            hosts.push(host);
          }
          return hosts;
        };
        nmapResult = parseXml(nmapOut);
      }
    } catch(e) { /* fallback */ }

    if (nmapResult && nmapResult.length > 0) {
      return res.json({ target, fuente: 'nmap', hosts: nmapResult, comando: 'nmap -sS -sV -T4 --open ' + target });
    }

    // Fallback: Node.js TCP scan on common ports
    const scanPromises = commonPorts.map(p => scanPort(ip, p.port, 2000));
    const results = await Promise.all(scanPromises);
    const openPorts = results.filter(r => r.state === 'open');
    const host = { ip, hostname: target !== ip ? target : '', ports: openPorts };
    res.json({ target, fuente: 'nodejs-tcp', hosts: [host], comando: 'nmap -sS -sV -T4 --open ' + target });
  } catch (e) { res.json({ error: e.message }); }
});

// === OpenVAS (vulnerability scan via Node.js + nmap --script vuln si instalado) ===
const vulnHints = {
  21: 'FTP —可能的匿名登录或暴力破解', 23: 'Telnet —没有加密，容易窃听', 25: 'SMTP —可能的邮件中继（开放中继）',
  53: 'DNS —可能的DNS放大攻击', 80: 'HTTP —缺失安全头，可能的XSS/SQLi', 110: 'POP3 —没有加密',
  143: 'IMAP —没有加密', 445: 'SMB —可能的EternalBlue/MS17-010', 993: 'IMAPS —检查证书',
  995: 'POP3S —检查证书', 1433: 'MSSQL —默认端口，可能的暴力破解', 3306: 'MySQL —默认端口，可能的暴力破解',
  3389: 'RDP —可能的BlueKeep/CVE-2019-0708', 5432: 'PostgreSQL —默认端口，可能的暴力破解',
  5900: 'VNC —没有密码或弱密码', 6379: 'Redis —可能需要认证', 27017: 'MongoDB —可能需要认证',
  8080: 'HTTP-alt —可能的代理或管理面板', 8443: 'HTTPS-alt —检查证书'
};

app.get('/api/openvas/:target', async (req, res) => {
  try {
    const target = req.params.target;
    if (!target) return res.json({ error: 'Especifica un target IP o dominio' });

    // Resolve hostname
    let ip = target;
    try {
      const { Resolver } = require('dns').promises;
      const resv = new Resolver();
      const addrs = await resv.resolve4(target);
      if (addrs && addrs.length > 0) ip = addrs[0];
    } catch(e) {}

    // Try nmap --script vuln first
    const { execFile } = require('child_process');
    let nmapVuln = null;
    try {
      const out = await new Promise((resolve, reject) => {
        execFile('nmap', ['--script', 'vuln', '-T4', '--open', '-oX', '-', target], { timeout: 300000 }, (err, stdout) => {
          if (err && err.code === 'ENOENT') { resolve(null); return; }
          if (err) { resolve(null); return; }
          resolve(stdout);
        });
      });
      if (out) {
        const parseXml = (xml) => {
          const hosts = []; const re = /<host[^>]*>[\s\S]*?<\/host>/g; let m;
          while ((m = re.exec(xml)) !== null) {
            const h = m[0]; const host = {};
            const a = h.match(/<address addr="([^"]+)"/); if (a) host.ip = a[1];
            const hn = h.match(/<hostname name="([^"]+)"/); if (hn) host.hostname = hn[1];
            const ports = []; const pr = /<port[^>]*>[\s\S]*?<\/port>/g; let pm;
            while ((pm = pr.exec(h)) !== null) {
              const p = pm[0]; const pn = p.match(/portid="(\d+)"/);
              const st = p.match(/<state state="([^"]+)"/); const sv = p.match(/<service name="([^"]+)"/);
              if (pn) ports.push({ port: parseInt(pn[1]), state: st ? st[1] : 'unknown', service: sv ? sv[1] : '' });
            }
            host.ports = ports;
            const scripts = []; const sr = /<script id="([^"]*)"[\s\S]*?output="([\s\S]*?)"\/>/g; let sm;
            while ((sm = sr.exec(h)) !== null) scripts.push({ id: sm[1], output: sm[2].substring(0, 300) });
            host.vulnerabilidades = scripts;
            hosts.push(host);
          }
          return hosts;
        };
        nmapVuln = parseXml(out);
      }
    } catch(e) {}

    if (nmapVuln && nmapVuln.length > 0) {
      let tv = 0; for (let h of nmapVuln) if (h.vulnerabilidades) tv += h.vulnerabilidades.length;
      return res.json({ target, fuente: 'nmap-script-vuln', hosts: nmapVuln, totalVulnerabilidades: tv, comando: 'nmap --script vuln -T4 --open ' + target });
    }

    // Fallback: Node.js TCP scan + vulnerability hints by port
    const scanPromises = commonPorts.map(p => scanPort(ip, p.port, 2000));
    const results = await Promise.all(scanPromises);
    const openPorts = results.filter(r => r.state === 'open');
    const vuls = [];
    for (const pt of openPorts) {
      const hint = vulnHints[pt.port];
      if (hint) vuls.push({ id: 'PORT-' + pt.port, output: hint });
    }
    const host = { ip, hostname: target !== ip ? target : '', ports: openPorts, vulnerabilidades: vuls };
    res.json({ target, fuente: 'nodejs-tcp', hosts: [host], totalVulnerabilidades: vuls.length, comando: 'nmap --script vuln -T4 --open ' + target });
  } catch (e) { res.json({ error: e.message }); }
});

// === CUIT por DNI (algoritmo público + consulta ARCA para obtener nombre) ===
app.get('/api/cuit-dni/:dni', async (req, res) => {
  try {
    const dniRaw = req.params.dni.replace(/\D/g, '');
    const genero = (req.query.genero || 'M').toUpperCase();
    if (!dniRaw || dniRaw.length < 7 || dniRaw.length > 8) return res.json({ error: 'DNI inválido. Debe tener 7 u 8 dígitos.' });

    const dni = dniRaw.padStart(8, '0');
    const prefijos = { 'M': 20, 'F': 27, 'X': 20 };
    let prefijo = prefijos[genero] || 20;
    if (genero !== 'M' && genero !== 'F' && genero !== 'X') prefijo = 20;

    const calcularDigito = (pref, d) => {
      const base = String(pref) + d;
      const pesos = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2];
      let suma = 0;
      for (let i = 0; i < 10; i++) suma += parseInt(base[i]) * pesos[i];
      let resto = suma % 11;
      let dv = 11 - resto;
      if (dv === 11) dv = 0;
      return { dv, necesitaRecalculo: dv === 10 };
    };

    let resultado = calcularDigito(prefijo, dni);
    if (resultado.necesitaRecalculo) {
      if (prefijo === 20) prefijo = 23;
      else if (prefijo === 27) prefijo = 24;
      else prefijo = 23;
      resultado = calcularDigito(prefijo, dni);
      if (resultado.dv === 10) resultado.dv = 9;
    }

    const cuitNumerico = String(prefijo) + dni + resultado.dv;
    const cuit = `${prefijo}-${dni}-${resultado.dv}`;

    // Try to get taxpayer name from ARCA (non-blocking, timeout 25s)
    let arcaData = null;
    try {
      arcaData = await Promise.race([
        consultarArca(cuitNumerico),
        new Promise(resolve => setTimeout(() => resolve(null), 25000))
      ]);
    } catch(e) { /* fallback: mostrar solo CUIT */ }

    const response = {
      dni,
      genero,
      cuit,
      prefijo,
      digitoVerificador: resultado.dv,
      cuitNumerico: parseInt(cuitNumerico),
      valido: true,
      enlaces: {
        cuitonline: 'https://www.cuitonline.com/detalle/' + cuitNumerico + '.html',
        dateas: 'https://www.dateas.com/es/cuit/' + cuitNumerico,
        constanciaAnses: 'https://servicios.anses.gob.ar/constanciacuil/'
      }
    };

    if (arcaData) {
      response.arca = arcaData;
      // Extract nombre/apellido from ARCA fields
      response.nombre = arcaData['Denominación'] || arcaData['Nombre'] || arcaData['Apellido y Nombre'] || arcaData['Razón Social'] || '';
    }

    res.json(response);
  } catch (e) { res.json({ error: e.message }); }
});

// === CMS Detector (like vulnx) ===
const cmsPatterns = [
  { name: 'WordPress', generator: '/wp-content/', headers: {}, paths: ['/wp-admin/', '/wp-login.php', '/xmlrpc.php'] },
  { name: 'Joomla', generator: '/components/', headers: {}, paths: ['/administrator/', '/modules/', '/templates/'] },
  { name: 'Drupal', generator: 'Drupal', headers: { 'X-Generator': 'Drupal' }, paths: ['/user/login', '/node', '/core/'] },
  { name: 'Magento', generator: 'Magento', headers: { 'X-Generator': 'Magento' }, paths: ['/admin', '/skin/', '/media/'] },
  { name: 'PrestaShop', generator: 'PrestaShop', headers: {}, paths: ['/admin/', '/modules/', '/themes/'] },
  { name: 'Shopify', generator: 'Shopify', headers: { 'X-ShopId': '' }, paths: [] },
  { name: 'Wix', generator: 'Wix.com', headers: {}, paths: [] },
  { name: 'Squarespace', generator: 'Squarespace', headers: {}, paths: [] },
  { name: 'Ghost', generator: 'Ghost', headers: {}, paths: ['/ghost/'] }
];

app.get('/api/cms-detect/:url', async (req, res) => {
  try {
    let target = req.params.url;
    if (!target.startsWith('http')) target = 'https://' + target;
    const url = new URL(target);
    const r = await fetch(target, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'Mozilla/5.0' }, redirect: 'follow' });
    const html = await r.text();
    const headers = Object.fromEntries(r.headers.entries());
    const found = [];

    for (const cms of cmsPatterns) {
      let score = 0;
      // Check generator meta
      const genMatch = html.match(/<meta\s+name=["']generator["'][^>]*content=["']([^"']+)["']/i);
      if (genMatch && genMatch[1].toLowerCase().includes(cms.name.toLowerCase())) score += 3;
      if (html.includes(cms.generator)) score += 2;
      // Check headers
      for (const [hk, hv] of Object.entries(cms.headers)) {
        if (headers[hk] && (!hv || headers[hk].toLowerCase().includes(hv.toLowerCase()))) score += 2;
      }
      // Check paths
      if (cms.paths.length > 0) {
        const pathChecks = await Promise.all(cms.paths.map(async p => {
          try {
            const pr = await fetch(url.origin + p, { method: 'HEAD', signal: AbortSignal.timeout(5000) });
            return pr.status < 400 ? 1 : 0;
          } catch { return 0; }
        }));
        score += pathChecks.reduce((a, b) => a + b, 0);
      }
      if (score >= 2) found.push({ cms: cms.name, confianza: Math.min(Math.round(score / cms.paths.length * 100), 95) + '%', score });
    }

    // Tech detection
    const tech = [];
    if (headers['x-powered-by']) tech.push(headers['x-powered-by']);
    if (headers['server']) tech.push(headers['server']);
    if (html.includes('jquery')) tech.push('jQuery');
    if (html.includes('react') || html.includes('React')) tech.push('React');
    if (html.includes('vue') || html.includes('Vue')) tech.push('Vue.js');
    if (html.includes('angular')) tech.push('Angular');
    if (html.includes('bootstrap')) tech.push('Bootstrap');
    if (html.includes('font-awesome') || html.includes('fontawesome')) tech.push('Font Awesome');

    res.json({ target, url: url.href, cms: found.length > 0 ? found : [{ cms: 'No detectado', confianza: '0%' }], tecnologias: [...new Set(tech)], headers_count: Object.keys(headers).length, status: r.status });
  } catch (e) { res.json({ error: e.message, target: req.params.url }); }
});

// === Admin Panel Finder (like XAttacker) ===
const adminPaths = [
  '/admin/', '/administrator/', '/admin.php', '/login/', '/wp-admin/', '/wp-login.php',
  '/cms/', '/panel/', '/manager/', '/backend/', '/dashboard/', '/controlpanel/',
  '/admin/login/', '/user/login/', '/admin/dashboard/', '/admin/panel/',
  '/cp/', '/manager/login/', '/administrator/login/', '/moderator/',
  '/webadmin/', '/sysadmin/', '/adminarea/', '/adminpanel/',
  '/phpmyadmin/', '/pma/', '/admin/login.php', '/admin/admin.php',
  '/login.php', '/admin/index.php', '/admin/admin_login/', '/admincp/',
  '/admin_area/', '/admin_area/login.php', '/admin_area/admin.php'
];

app.get('/api/admin-finder/:url', async (req, res) => {
  try {
    let target = req.params.url;
    if (!target.startsWith('http')) target = 'https://' + target;
    const url = new URL(target);
    const limit = parseInt(req.query.limit) || 15;

    const checks = await Promise.all(adminPaths.slice(0, limit).map(async p => {
      try {
        const pr = await fetch(url.origin + p, { method: 'HEAD', signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0' } });
        if (pr.status < 400) {
          // Try GET for more accurate detection
          const gr = await fetch(url.origin + p, { signal: AbortSignal.timeout(5000), headers: { 'User-Agent': 'Mozilla/5.0' } });
          const text = await gr.text();
          const hasForm = text.includes('password') || text.includes('login') || text.includes('user') || text.includes('admin');
          return { path: p, status: pr.status, tipo: hasForm ? 'formulario_login' : 'pagina', tamaño: text.length };
        }
        return null;
      } catch { return null; }
    }));

    const found = checks.filter(Boolean);
    res.json({ target, total_checked: Math.min(limit, adminPaths.length), encontrados: found.length, resultados: found });
  } catch (e) { res.json({ error: e.message, target: req.params.url }); }
});

// === Security Headers Scanner ===
const secHeaders = {
  'Strict-Transport-Security': { desc: 'HTTP Strict Transport Security (HSTS)', bueno: true },
  'Content-Security-Policy': { desc: 'Content Security Policy (CSP)', bueno: true },
  'X-Frame-Options': { desc: 'Proteccion contra clickjacking', bueno: true },
  'X-Content-Type-Options': { desc: 'Proteccion contra MIME sniffing', bueno: true },
  'Referrer-Policy': { desc: 'Control de referer', bueno: true },
  'Permissions-Policy': { desc: 'Restriccion de APIs del navegador', bueno: true },
  'X-XSS-Protection': { desc: 'Proteccion contra XSS (deprecated)', bueno: true },
  'Access-Control-Allow-Origin': { desc: 'CORS permite origenes', bueno: false },
  'Public-Key-Pins': { desc: 'HTTP Public Key Pinning (deprecated)', bueno: true },
  'Set-Cookie': { desc: 'Cookies configuradas', bueno: false }
};

app.get('/api/sec-headers/:url', async (req, res) => {
  try {
    let target = req.params.url;
    if (!target.startsWith('http')) target = 'https://' + target;
    const r = await fetch(target, { method: 'HEAD', signal: AbortSignal.timeout(10000), headers: { 'User-Agent': 'Mozilla/5.0' } });
    const headers = Object.fromEntries(r.headers.entries());

    const presentes = [];
    const ausentes = [];

    for (const [hk, hv] of Object.entries(secHeaders)) {
      const hkLower = hk.toLowerCase();
      const foundKey = Object.keys(headers).find(k => k.toLowerCase() === hkLower);
      if (foundKey) {
        presentes.push({ header: hk, valor: headers[foundKey].substring(0, 100), desc: hv.desc });
      } else {
        ausentes.push({ header: hk, desc: hv.desc });
      }
    }

    // Cookie security check
    const cookieHeader = Object.keys(headers).find(k => k.toLowerCase() === 'set-cookie');
    const cookies = cookieHeader ? headers[cookieHeader] : '';
    const cookieFlags = [];
    if (cookies) {
      if (cookies.includes('Secure')) cookieFlags.push('Secure ✓');
      else cookieFlags.push('Secure ✗');
      if (cookies.includes('HttpOnly')) cookieFlags.push('HttpOnly ✓');
      else cookieFlags.push('HttpOnly ✗');
      if (cookies.includes('SameSite')) cookieFlags.push('SameSite ✓');
      else cookieFlags.push('SameSite ✗');
    }

    res.json({
      target,
      url: r.url,
      status: r.status,
      total_presentes: presentes.length,
      total_ausentes: ausentes.length,
      presentes,
      ausentes,
      cookies: cookieFlags.length > 0 ? cookieFlags : null,
      server: headers['server'] || headers['Server'] || null,
      powered_by: headers['x-powered-by'] || headers['X-Powered-By'] || null
    });
  } catch (e) { res.json({ error: e.message, target: req.params.url }); }
});

const PORT = 3450;
app.listen(PORT, () => console.log('OSINT Dashboard -> http://localhost:' + PORT));