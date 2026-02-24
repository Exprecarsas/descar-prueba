document.addEventListener('DOMContentLoaded', function () {

  const TIPO_FIJO = 'DESCARGUE';
  const SEDE_STORAGE_KEY = 'sede_descargue_actual';

  let products = [];
  let scannedUnits = {};
  let globalUnitsScanned = 0;
  let totalUnits = 0;

  let audioContext;
  let codigosCorrectos = [];
  let codigosIncorrectos = [];
  let barcodeTimeout;

  let enviandoProceso = false;
  let firmaUltimoEnvio = null;

  /* ======================================================
     UTILIDADES
  ====================================================== */

  function generarFirmaDatos() {
    return JSON.stringify({
      correctos: codigosCorrectos.map(c => c.codigo).sort(),
      incorrectos: codigosIncorrectos.map(c => c.codigo).sort(),
      total: globalUnitsScanned
    });
  }

  function normalizarTexto(texto) {
    return texto
      .toUpperCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function mostrarInfoProceso() {
    const info = localStorage.getItem('proceso_info');
    if (!info) return;

    const data = JSON.parse(info);
    const box = document.getElementById('info-proceso');

    if (!box) return;

    box.innerHTML = `
      🚛 <strong>Placa:</strong> ${data.placa}<br>
      🏙 <strong>Origen:</strong> ${data.remitente}<br>
      🏢 <strong>Sede:</strong> ${data.sede}<br>
      📅 <strong>Fecha:</strong> ${data.fecha}
    `;
    box.style.display = 'block';
  }

  /* ======================================================
     AUDIO
  ====================================================== */

  function initializeAudioContext() {
    if (!audioContext)
      audioContext = new (window.AudioContext || window.webkitAudioContext)();
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

  /* ======================================================
     PERSISTENCIA
  ====================================================== */

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
  mostrarInfoProceso();

  /* ======================================================
     CARGAR ARCHIVO Y CREAR PROCESO
  ====================================================== */

  document.getElementById('cargar-desde-drive').addEventListener('click', async () => {

    const fileId = document.getElementById('archivo-select').value;
    if (!fileId) {
      alert("Selecciona un cliente.");
      return;
    }

    const placa = prompt("Placa del vehículo:");
    if (!placa) return;

    const remitente = prompt("Ciudad origen:");
    if (!remitente) return;

    const sede = localStorage.getItem(SEDE_STORAGE_KEY) || 'SIN SEDE';
    const fecha = new Date().toISOString().slice(0, 10);

    const crearProcesoResp = await fetch('https://exprecar.com/api/crear_proceso.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo: 'DESCARGUE',
        placa: placa.toUpperCase(),
        sede: sede.toUpperCase(),
        remitente: remitente.toUpperCase(),
        fecha_operativa: fecha
      })
    });

    const procesoData = await crearProcesoResp.json();
    if (!procesoData.ok) {
      alert("Error creando proceso.");
      return;
    }

    const proceso_id = procesoData.proceso_id;
    localStorage.setItem('proceso_activo', proceso_id);

    localStorage.setItem('proceso_info', JSON.stringify({
      placa: placa.toUpperCase(),
      remitente: remitente.toUpperCase(),
      sede: sede.toUpperCase(),
      fecha
    }));

    mostrarInfoProceso();

    const exportUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv`;

    fetch(exportUrl)
      .then(r => r.text())
      .then(csvText => {

        Papa.parse(csvText, {
          header: true,
          skipEmptyLines: true,
          complete: async (results) => {

            products = results.data.map(item => ({
              codigo_barra: (item['codigo_barra'] || '').trim(),
              cantidad: parseInt((item['cantidad'] || '0'), 10),
              ciudad: (item['ciudad'] || '').trim(),
              codigos_validos: [(item['codigo_barra'] || '').trim()],
              scannedSubcodes: [],
              noSufijoCount: 0
            }));

            scannedUnits = {};
            globalUnitsScanned = 0;
            totalUnits = products.reduce((acc, p) => acc + p.cantidad, 0);

            products.forEach(p => scannedUnits[p.codigo_barra] = 0);

            updateScannedList();
            updateGlobalCounter();
            saveProgressToLocalStorage();

            alert("Archivo cargado correctamente.");
          }
        });
      });
  });

  /* ======================================================
     ESCANEO
  ====================================================== */

  document.getElementById('barcodeInput').addEventListener('input', () => {
    const val = document.getElementById('barcodeInput').value.trim();
    clearTimeout(barcodeTimeout);

    if (val !== '') {
      barcodeTimeout = setTimeout(() => {
        handleBarcodeScan(val);
        document.getElementById('barcodeInput').value = '';
      }, 800);
    }
  });

  function handleBarcodeScan(rawCode) {

    const now = new Date().toLocaleTimeString();
    const parts = rawCode.split('-');
    const main = parts[0];

    const p = products.find(x => x.codigos_validos.includes(main));

    if (!p) {
      codigosIncorrectos.push({ codigo: rawCode, hora: now });
      playTone(220, 400, 'square');
      alert("Código no encontrado.");
      return;
    }

    if (scannedUnits[p.codigo_barra] >= p.cantidad) {
      alert("Cantidad ya completada.");
      return;
    }

    codigosCorrectos.push({ codigo: rawCode, hora: now });
    scannedUnits[p.codigo_barra]++;
    globalUnitsScanned++;

    playTone(440, 150, 'sine');

    updateScannedList(p.codigo_barra);
    updateGlobalCounter();
    saveProgressToLocalStorage();
  }

  /* ======================================================
     UI
  ====================================================== */

  function updateScannedList(highlight = '') {
    const ul = document.getElementById('scanned-list');
    ul.innerHTML = '';

    products.forEach(p => {

      const done = scannedUnits[p.codigo_barra];
      const pct = p.cantidad ? (done / p.cantidad) * 100 : 0;

      const li = document.createElement('li');
      li.innerHTML = `
        <strong>${p.codigo_barra}</strong><br>
        Ciudad: ${p.ciudad}<br>
        <div class="progress-bar">
          <div class="progress-bar-inner" style="width:${pct}%"></div>
        </div>
        ${done} de ${p.cantidad}
      `;

      ul.appendChild(li);
    });
  }

  function updateGlobalCounter() {
    document.getElementById('global-counter').innerText =
      `Unidades descargadas: ${globalUnitsScanned} de ${totalUnits}`;
  }

  /* ======================================================
     TERMINAR PROCESO
  ====================================================== */

  document.getElementById('terminar-proceso').addEventListener('click', () => {

    if (!confirm("Finalizar proceso?")) return;

    localStorage.removeItem('scanProgress');
    localStorage.removeItem('proceso_activo');
    localStorage.removeItem('proceso_info');

    products = [];
    scannedUnits = {};
    globalUnitsScanned = 0;
    totalUnits = 0;
    codigosCorrectos = [];
    codigosIncorrectos = [];

    updateScannedList();
    updateGlobalCounter();

    alert("Proceso finalizado.");
  });

  /* ======================================================
     ENVIAR (SIN VOLVER A PEDIR PLACA)
  ====================================================== */

  document.getElementById('generar-reporte').addEventListener('click', async () => {

    if (enviandoProceso) return;

    const procesoActivo = localStorage.getItem('proceso_activo');

    if (!procesoActivo) {
      alert("No hay proceso activo.");
      return;
    }

    if (!codigosCorrectos.length && !codigosIncorrectos.length) {
      alert("No hay códigos para enviar.");
      return;
    }

    const unidades = [];

    codigosCorrectos.forEach(c => {
      unidades.push({ codigo: c.codigo, hora: c.hora, estado: "CORRECTO" });
    });

    codigosIncorrectos.forEach(c => {
      unidades.push({ codigo: c.codigo, hora: c.hora, estado: "NO_PLANILLADO" });
    });

    try {

      enviandoProceso = true;

      const resp = await fetch('https://exprecar.com/api/guardar_proceso.php', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proceso_id: Number(procesoActivo),
          unidades
        })
      });

      const data = await resp.json();
      if (!data.ok) throw new Error();

      alert(`Enviado correctamente\nTotal: ${data.total_unidades}`);

    } catch (e) {
      alert("Error guardando.");
    }

    enviandoProceso = false;
  });

});
