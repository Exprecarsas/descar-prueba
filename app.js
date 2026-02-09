document.addEventListener('DOMContentLoaded', function () {
  const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzdSV_gKJaqN11-naw6L2mgmo9_ncuaYFYbsGKH9j9jeKuzCGQ8xMWu48oaw2GbsvULsg/exec';
  const TIPO_FIJO = 'DESCARGUE';
  const SEDE_STORAGE_KEY = 'sede_descargue_actual';

  let products = [];
  let scannedUnits = {};
  let globalUnitsScanned = 0;
  let totalUnits = 0;
  let audioContext;
  let scanLock = false;
  let codigosCorrectos = [];
  let codigosIncorrectos = [];
  let barcodeTimeout;

  // CONTROL DE ENVÍO
  let enviandoProceso = false;
  let firmaUltimoEnvio = null;

  function generarFirmaDatos() {
    return JSON.stringify({
      codigosCorrectos,
      codigosIncorrectos,
      globalUnitsScanned
    });
  }

  // AUDIO
  function initializeAudioContext() {
    if (!audioContext) audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  function playTone(freq, dur, type = 'sine', vol = 1.0) {
    try {
      if (!audioContext) initializeAudioContext();
      const osc = audioContext.createOscillator();
      const gain = audioContext.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, audioContext.currentTime);
      gain.gain.value = vol;
      osc.connect(gain);
      gain.connect(audioContext.destination);
      osc.start();
      setTimeout(() => osc.stop(), dur);
    } catch (e) {}
  }

  document.body.addEventListener('click', initializeAudioContext, { once: true });

  // PERSISTENCIA
  function saveProgressToLocalStorage() {
    const data = {
      products,
      scannedUnits,
      globalUnitsScanned,
      totalUnits,
      codigosCorrectos,
      codigosIncorrectos
    };
    const compressed = LZString.compress(JSON.stringify(data));
    localStorage.setItem('scanProgress', compressed);
  }

  function restoreProgressFromLocalStorage() {
    const saved = localStorage.getItem('scanProgress');
    if (!saved) return;
    const json = LZString.decompress(saved);
    if (!json) return;
    try {
      const d = JSON.parse(json);
      products = d.products || [];
      scannedUnits = d.scannedUnits || {};
      globalUnitsScanned = d.globalUnitsScanned || 0;
      totalUnits = d.totalUnits || 0;
      codigosCorrectos = d.codigosCorrectos || [];
      codigosIncorrectos = d.codigosIncorrectos || [];
      updateScannedList();
      updateGlobalCounter();
    } catch (e) {}
  }
  restoreProgressFromLocalStorage();

  // SEDE
  const sedeSelect = document.getElementById('sede');
  const sedeBadge = document.getElementById('sede-activa');

  if (sedeSelect) {
    const savedSede = localStorage.getItem(SEDE_STORAGE_KEY);
    if (savedSede) {
      sedeSelect.value = savedSede;
      if (sedeBadge) sedeBadge.textContent = `✅ Sede actual: ${savedSede}`;
    }
    sedeSelect.addEventListener('change', () => {
      const v = sedeSelect.value || '';
      localStorage.setItem(SEDE_STORAGE_KEY, v);
      if (sedeBadge) {
        sedeBadge.textContent = v ? `✅ Sede actual: ${v}` : '⚠️ Sin sede seleccionada';
      }
    });
  }

  // CARGAR ARCHIVO
  document.getElementById('cargar-desde-drive').addEventListener('click', () => {
    const fileId = document.getElementById('archivo-select').value;
    if (!fileId) {
      alert("Selecciona un cliente para cargar su archivo.");
      return;
    }

    const exportUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv`;
    fetch(exportUrl)
      .then(r => r.text())
      .then(csvText => {
        Papa.parse(csvText, {
          header: true,
          skipEmptyLines: true,
          complete: (results) => {

            products = results.data.map(item => {
              const codigoBarra = (item['codigo_barra'] || '').trim();
              const documentoTercero = (item['documento_tercero'] || '').trim();
              const codigosAdicionales = (item['codigos_adicionales'] || '')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);

              const codigos_validos = [codigoBarra];
              if (documentoTercero) codigos_validos.push(documentoTercero);
              codigosAdicionales.forEach(c => codigos_validos.push(c));

              return {
                codigo_barra: codigoBarra,
                documento_tercero: documentoTercero,
                cantidad: parseInt((item['cantidad'] || '0').trim(), 10),
                ciudad: (item['ciudad'] || '').trim(),
                codigos_validos,
                scannedSubcodes: [],
                noSufijoCount: 0
              };
            });

            scannedUnits = {};
            globalUnitsScanned = 0;
            totalUnits = products.reduce((acc, p) => acc + (p.cantidad || 0), 0);
            products.forEach(p => { scannedUnits[p.codigo_barra] = 0; });

            updateScannedList();
            updateGlobalCounter();
            saveProgressToLocalStorage();

            document.getElementById('archivo-select').disabled = true;
            document.getElementById('cargar-desde-drive').disabled = true;

            alert("Archivo cargado correctamente.");
          }
        });
      });
  });

  // ESCÁNER INPUT
  document.getElementById('barcodeInput').addEventListener('input', () => {
    const val = document.getElementById('barcodeInput').value.trim();
    clearTimeout(barcodeTimeout);
    if (val !== '') {
      barcodeTimeout = setTimeout(() => {
        handleBarcodeScan(val);
        document.getElementById('barcodeInput').value = '';
      }, 1000);
    }
  });

  function obtenerHoraFormateada() {
    const d = new Date();
    let h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    const pad = n => n < 10 ? '0'+n : n;
    return `${h}:${pad(m)}:${pad(s)} ${ampm}`;
  }

  function handleBarcodeScan(scannedCode) {
    const rawCode = scannedCode.trim();
    const now = obtenerHoraFormateada();

    const p = products.find(x => x.codigos_validos.includes(rawCode));

    if (p) {
      codigosCorrectos.push({ codigo: rawCode, hora: now });
      scannedUnits[p.codigo_barra] += 1;
      globalUnitsScanned += 1;
      playTone(440,180);
    } else {
      codigosIncorrectos.push({ codigo: rawCode, hora: now });
      playTone(220,400);
    }

    updateScannedList();
    updateGlobalCounter();
    saveProgressToLocalStorage();
  }

  function updateScannedList() {
    const ul = document.getElementById('scanned-list');
    ul.innerHTML = '';
    products.forEach(p => {
      const li = document.createElement('li');
      li.textContent = `${p.codigo_barra} - ${scannedUnits[p.codigo_barra]}/${p.cantidad}`;
      ul.appendChild(li);
    });
  }

  function updateGlobalCounter() {
    document.getElementById('global-counter').innerText =
      `Unidades descargadas: ${globalUnitsScanned} de ${totalUnits}`;
  }

  // ABRIR MODAL CON ANIMACIÓN
  const btnAbrir = document.getElementById('finalizar-descarga');
  btnAbrir.addEventListener('click', () => {
    btnAbrir.disabled = true;
    const txt = btnAbrir.innerHTML;
    btnAbrir.innerHTML = "Procesando...";
    setTimeout(()=>{
      document.getElementById('modal').style.display='flex';
      document.getElementById('fecha').value=new Date().toLocaleDateString();
      btnAbrir.disabled=false;
      btnAbrir.innerHTML=txt;
    },400);
  });

  document.getElementById('cerrar-modal').addEventListener('click',()=>{
    document.getElementById('modal').style.display='none';
  });

  // ENVIAR A GOOGLE SHEETS
  document.getElementById('generar-reporte').addEventListener('click', async () => {

    if(enviandoProceso) return;

    const firmaActual = generarFirmaDatos();
    if(firmaUltimoEnvio && firmaActual===firmaUltimoEnvio){
      alert("Este proceso ya fue enviado.");
      return;
    }

    const payload={
      meta:{total_unidades:globalUnitsScanned},
      comparativo:{codigosCorrectos,codigosIncorrectos}
    };

    const btn=document.getElementById('generar-reporte');
    const original=btn.textContent;

    try{
      enviandoProceso=true;
      btn.disabled=true;
      btn.textContent="Enviando...";

      const resp=await fetch(SCRIPT_URL,{
        method:'POST',
        headers:{'Content-Type':'text/plain;charset=UTF-8'},
        body:JSON.stringify(payload)
      });

      if(!resp.ok) throw new Error();

      firmaUltimoEnvio=firmaActual;
      alert("Enviado correctamente");
      document.getElementById('modal').style.display='none';

    }catch(err){
      alert("Error enviando");
    }finally{
      enviandoProceso=false;
      btn.disabled=false;
      btn.textContent=original;
    }

  });

});

