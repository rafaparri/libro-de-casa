/* Borrador mensual de previsiones de Libro de Casa.
   Lee los libros desde Firestore (con la cuenta de acceso), genera el borrador de previsión del mes
   siguiente con el MISMO criterio que la app (máximo de los últimos 6 meses con datos; meses con pago no
   mensual excluidos del máximo; pago no mensual del mes sumado a la base) y envía un correo de aviso. */
const nodemailer = require('nodemailer');

const PROJECT = 'mi-plan-halterofilia';
const API_KEY = 'AIzaSyAZsCxPgTvFddB5IhDe6hqWtkycykMXAKw';
const COLLECTION = 'libro_de_casa';
const APP_URL = process.env.APP_URL || 'https://rafaparri.github.io/libro-de-casa/';
const MESES = ['enero','febrero','marzo','abril','mayo','junio','julio','agosto','septiembre','octubre','noviembre','diciembre'];
const eur = n => new Intl.NumberFormat('es-ES',{style:'currency',currency:'EUR'}).format(Number(n)||0);
const label = mk => { const [y,m]=mk.split('-').map(Number); return `${MESES[m-1]} ${y}`; };
const shift = (mk,d)=>{ const [y,m]=mk.split('-').map(Number); const dt=new Date(Date.UTC(y,m-1+d,1)); return dt.getUTCFullYear()+'-'+String(dt.getUTCMonth()+1).padStart(2,'0'); };
const isIncome = g => String(g||'').toUpperCase().includes('INGRESO');

/* ---------- Firestore REST ---------- */
let TOKEN = null;
const BASE = process.env.TEST_FIRESTORE || `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${COLLECTION}`;
async function login(){
  const r = await fetch(process.env.TEST_AUTH || `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${API_KEY}`,{
    method:'POST', headers:{'Content-Type':'application/json'},
    body: JSON.stringify({email:process.env.FIREBASE_EMAIL, password:process.env.FIREBASE_PASSWORD, returnSecureToken:true})});
  const j = await r.json();
  if(!r.ok) throw new Error('No se pudo iniciar sesión en Firebase: '+(j.error&&j.error.message));
  TOKEN = j.idToken;
}
const hdr = () => ({Authorization:'Bearer '+TOKEN});
async function getDoc(id, def=null){
  const r = await fetch(`${BASE}/${encodeURIComponent(id)}`,{headers:hdr()});
  if(r.status===404) return def;
  const j = await r.json();
  if(!r.ok) throw new Error(`Leyendo ${id}: ${JSON.stringify(j)}`);
  const s = j.fields && j.fields.value && j.fields.value.stringValue;
  return s==null ? def : JSON.parse(s);
}
async function setDoc(id, value){
  const r = await fetch(`${BASE}/${encodeURIComponent(id)}?updateMask.fieldPaths=value`,{
    method:'PATCH', headers:{...hdr(),'Content-Type':'application/json'},
    body: JSON.stringify({fields:{value:{stringValue:JSON.stringify(value)}}})});
  if(!r.ok) throw new Error(`Escribiendo ${id}: ${await r.text()}`);
}
async function listIds(){
  const ids=[]; let pageToken='';
  do{
    const r = await fetch(`${BASE}?pageSize=300&mask.fieldPaths=_&${pageToken?'pageToken='+encodeURIComponent(pageToken):''}`,{headers:hdr()});
    const j = await r.json();
    if(!r.ok) throw new Error('Listando documentos: '+JSON.stringify(j));
    (j.documents||[]).forEach(d=>ids.push(decodeURIComponent(d.name.split('/').pop())));
    pageToken = j.nextPageToken||'';
  }while(pageToken);
  return ids;
}

/* ---------- Lógica (idéntica a la app) ---------- */
const netoCat = (txs,tipo)=>Math.abs(txs.filter(t=>!t.voided&&t.tipo===tipo).reduce((a,t)=>a+t.importe,0));

async function borradorHogar(h, ids, target, forzar){
  const P = `h_${h}__`;
  const cats = await getDoc(P+'categories', null);
  if(!cats) return {h, skip:'sin categorías (hogar sin configurar)'};
  const nm = await getDoc(P+'pagos_no_mensuales', []);
  const meta = await getDoc(P+'hogar_meta', null);
  const nombre = meta && meta.nombre || h;
  const bors = await getDoc(P+'presup_borradores', {});
  const budget = await getDoc(P+`budget:${target}`, {});
  if(!forzar){
    if(bors[target]){
      const b = bors[target];
      if(b.revisado) return {h, nombre, skip:'el borrador de '+label(target)+' ya está revisado'};
      // ya existía un borrador sin revisar (p. ej. lo generó la app al abrirla): se avisa igualmente
      const nmMes = nm.filter(p=>p.meses&&p.meses.includes(Number(target.split('-')[1])));
      const gCats = cats.map(c=>c[0]).filter(t=>!isIncome((cats.find(c=>c[0]===t)||[])[1]));
      const total = gCats.reduce((acc,t)=>{ const bb=Number(budget[t])||0; return acc + (bb>0 ? bb : nmMes.filter(p=>p.tipo===t).reduce((x,p)=>x+Number(p.importe),0)); },0);
      return {h, nombre, ok:true, existente:true, generadoEl:b.generadoEl, hist:b.meses||[], totalPrev:total, nmTocan:b.nmTocan||[], nmProximos:b.nmProximos||[], atrasados:b.atrasados||[]};
    }
    if(Object.values(budget).some(v=>Number(v)>0)) return {h, nombre, skip:'ya tiene previsión en '+label(target)};
  }
  const groupOf = t => (cats.find(c=>c[0]===t)||[])[1];
  const gastoCats = cats.map(c=>c[0]).filter(t=>!isIncome(groupOf(t)));

  const monthKeys = ids.filter(i=>i.startsWith(P+'tx:')).map(i=>i.slice((P+'tx:').length)).filter(k=>/^\d{4}-\d{2}$/.test(k)&&k<target).sort().reverse();
  const txCache = {};
  const loadTx = async k => txCache[k] ||= await getDoc(P+'tx:'+k, []);
  const hist = [];
  for(const k of monthKeys){ if(hist.length>=6) break; if((await loadTx(k)).some(t=>!t.voided)) hist.push(k); }
  hist.sort();
  if(hist.length===0) return {h, nombre, skip:'sin histórico de movimientos'};

  const mNum = Number(target.split('-')[1]);
  const nmDue = nm.filter(p=>p.meses&&p.meses.includes(mNum));
  const nmDueBy = {}; nmDue.forEach(p=>(nmDueBy[p.tipo]=nmDueBy[p.tipo]||[]).push(p));
  const nuevo = {}, notas = {};
  let totalPrev = 0;
  for(const tipo of gastoCats){
    let max=0, maxMes=null, excl=0;
    for(const hm of hist){
      const n = Number(hm.split('-')[1]);
      if(nm.some(p=>p.tipo===tipo&&p.meses&&p.meses.includes(n))){ excl++; continue; }
      const v = netoCat(await loadTx(hm), tipo);
      if(v>max){ max=v; maxMes=hm; }
    }
    const reg = Math.ceil(max-0.0001);
    const nmSum = (nmDueBy[tipo]||[]).reduce((a,p)=>a+Number(p.importe),0);
    let base = reg; const partes=[];
    partes.push(reg>0 ? `Máx. últimos ${hist.length} m.: ${eur(reg)} (${MESES[Number(maxMes.split('-')[1])-1].slice(0,3)})` : 'Sin gastos en el histórico');
    if(excl>0) partes.push(`${excl} mes(es) con pago no mensual excluidos del máximo`);
    if(nmSum>0){ base = reg+Math.ceil(nmSum-0.0001); partes.push(`incluye pago no mensual: ${nmDueBy[tipo].map(p=>p.nombre+' '+eur(p.importe)).join(', ')}`); }
    nuevo[tipo]=base; notas[tipo]=partes.join(' · ');
    totalPrev += base;
  }
  const nmTocan = nmDue.map(p=>({nombre:p.nombre,tipo:p.tipo,importe:Number(p.importe)}));
  const nmProximos=[];
  for(const d of [1,2]){ const mm=shift(target,d), n=Number(mm.split('-')[1]); nm.filter(p=>p.meses&&p.meses.includes(n)).forEach(p=>nmProximos.push({nombre:p.nombre,tipo:p.tipo,importe:Number(p.importe),mes:mm})); }
  const atrasados=[];
  for(const d of [-1,-2,-3]){
    const mm=shift(target,d), n=Number(mm.split('-')[1]);
    const items = nm.filter(p=>p.meses&&p.meses.includes(n)); if(!items.length) continue;
    const txs = await loadTx(mm);
    items.forEach(p=>{ const g=netoCat(txs,p.tipo); if(g<0.5*Number(p.importe)) atrasados.push({nombre:p.nombre,tipo:p.tipo,importe:Number(p.importe),mes:mm,gastado:g}); });
  }
  // se conservan las categorías de ingresos u otras claves que ya hubiera en el presupuesto
  await setDoc(P+`budget:${target}`, {...budget, ...nuevo});
  bors[target] = {generadoEl:new Date().toISOString(), generadoPor:'auto', meses:hist, revisado:false, notas, nmTocan, nmProximos, atrasados};
  await setDoc(P+'presup_borradores', bors);
  const runMk = new Date().toISOString().slice(0,7);
  const audit = await getDoc(P+`audit:${runMk}`, []);
  audit.push({ts:new Date().toISOString(), user:'auto', username:'auto', action:'Borrador de previsión generado', detail:`${label(target)} a partir de ${hist.length} mes(es) de histórico (máximo reciente) — proceso automático`});
  await setDoc(P+`audit:${runMk}`, audit);
  return {h, nombre, ok:true, hist, totalPrev, nmTocan, nmProximos, atrasados};
}

async function main(){
  const forzar = process.env.FORZAR === 'true';
  const hoy = new Date();
  const target = process.env.MES_DESTINO || shift(hoy.toISOString().slice(0,7), 1);
  await login();
  const ids = await listIds();
  const hogares = [...new Set(ids.filter(i=>/^h_.+__users$/.test(i)).map(i=>i.slice(2,-7)))];
  console.log('Hogares:', hogares.join(', '), '· mes destino:', target);
  const res = [];
  for(const h of hogares){
    try{ res.push(await borradorHogar(h, ids, target, forzar)); }
    catch(e){ console.error('Error en', h, e); res.push({h, error:e.message}); }
  }
  console.log(JSON.stringify(res.map(r=>({h:r.h,ok:r.ok,skip:r.skip,error:r.error,total:r.totalPrev})),null,1));
  console.log('::notice title=Resultado por libro::'+res.map(r=>`${r.nombre||r.h}: ${r.ok?(r.existente?'borrador existente sin revisar':'borrador generado'):(r.skip||('ERROR '+r.error))}`).join(' | '));
  const generados = res.filter(r=>r.ok), errores = res.filter(r=>r.error);
  if(generados.length===0 && errores.length===0){ console.log('No hay nada nuevo que avisar.'); console.log('::notice title=Correo::no enviado, nada nuevo que avisar'); return; }

  const li = a => a.map(x=>`<li>${x}</li>`).join('');
  let html = `<div style="font-family:Arial,sans-serif;font-size:16px;line-height:1.5;max-width:640px;">`;
  html += `<h2 style="margin-bottom:4px;">Borrador de previsiones de ${label(target)} listo para revisar</h2>`;
  html += `<p>Revísalo y ajústalo <b>antes del día 25</b>. Entra aquí: <a href="${APP_URL}">${APP_URL}</a> → Presupuesto → ${label(target)}.</p>`;
  for(const r of generados){
    html += `<h3 style="margin:18px 0 4px;">${r.nombre}</h3><p style="margin:0;">Previsión total de gastos propuesta: <b>${eur(r.totalPrev)}</b> (máximo de los últimos ${r.hist.length} meses de cada categoría).${r.existente?` Borrador generado el ${new Date(r.generadoEl).toLocaleDateString('es-ES')}, <b>aún sin revisar</b>.`:''}</p>`;
    html += r.nmTocan.length ? `<p style="margin:8px 0 2px;"><b>Pagos no mensuales que tocan este mes:</b></p><ul>${li(r.nmTocan.map(p=>`${p.nombre} (${p.tipo}): ${eur(p.importe)}`))}</ul>` : `<p style="margin:8px 0;">Este mes no toca ningún pago no mensual.</p>`;
    if(r.nmProximos.length) html += `<p style="margin:8px 0 2px;"><b>Próximos dos meses:</b></p><ul>${li(r.nmProximos.map(p=>`${label(p.mes)}: ${p.nombre} ${eur(p.importe)}`))}</ul>`;
    if(r.atrasados.length) html += `<p style="margin:8px 0 2px;color:#a33;"><b>⚠ Posibles pagos no mensuales atrasados:</b></p><ul>${li(r.atrasados.map(p=>`${label(p.mes)}: ${p.nombre} (${p.tipo}) ${eur(p.importe)} — gastado en la categoría: ${eur(p.gastado)}`))}</ul>`;
  }
  const omitidos = res.filter(r=>r.skip);
  if(omitidos.length) html += `<p style="color:#666;font-size:14px;">Omitidos: ${omitidos.map(r=>`${r.nombre||r.h} (${r.skip})`).join('; ')}.</p>`;
  if(errores.length) html += `<p style="color:#a33;"><b>Errores:</b> ${errores.map(r=>`${r.h}: ${r.error}`).join('; ')}</p>`;
  html += `</div>`;

  if(process.env.NO_MAIL){ console.log('HTML:', html.replace(/<[^>]+>/g,' ').replace(/\s+/g,' ').slice(0,1500)); return; }
  const tr = nodemailer.createTransport({service:'gmail', auth:{user:process.env.GMAIL_USER, pass:process.env.GMAIL_APP_PASSWORD}});
  console.log('::notice title=Correo::enviando con usuario '+(process.env.GMAIL_USER||'(vacío)')+' contraseña '+(process.env.GMAIL_APP_PASSWORD?'presente ('+process.env.GMAIL_APP_PASSWORD.length+' caracteres)':'AUSENTE'));
  await tr.sendMail({from:`Libro de Casa <${process.env.GMAIL_USER}>`, to:process.env.MAIL_TO||process.env.GMAIL_USER,
    subject:`📝 Borrador de previsiones de ${label(target)} listo para revisar`, html});
  console.log('Correo enviado.'); console.log('::notice title=Correo::enviado a '+(process.env.MAIL_TO||process.env.GMAIL_USER));
  if(errores.length) process.exitCode = 1;
}
main().catch(e=>{ console.error(e); process.exit(1); });
