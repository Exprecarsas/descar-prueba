document.addEventListener('DOMContentLoaded', function () {
  const SCRIPT_URL = 'https://script.google.com/macros/s/AKfycbzdSV_gKJaqN11-naw6L2mgmo9_ncuaYFYbsGKH9j9jeKuzCGQ8xMWu48oaw2GbsvULsg/exec'; // <-- tu /exec
  const TIPO_FIJO = 'DESCARGUE';
  const SEDE_STORAGE_KEY = 'sede_descargue_actual'; // para recordar la sede (check-in)

  let products = [];            // desde CSV de Drive
  let scannedUnits = {};        // contador por código_barra
  let globalUnitsScanned = 0;   // total escaneado
  let totalUnits = 0;           // total esperado
  let html5QrCode;              // cámara (opcional)
  let audioContext;
  let scanLock = false;
  let codigosCorrectos = [];    // [{codigo, hora}] con código COMPLETO (incluye sufijo)
  let codigosIncorrectos = [];  // [{codigo, hora}] igual
  let barcodeTimeout;

  let enviandoProceso = false;
  let firmaUltimoEnvio = null;
  let procesoYaEnviado = false;

  function generarFirmaDatos() {
    return JSON.stringify({
      correctos: codigosCorrectos.map(c => c.codigo).sort(),
      incorrectos: codigosIncorrectos.map(c => c.codigo).sort(),
      total: globalUnitsScanned
    });
  }
  function mostrarInfoProceso() {
    const info = localStorage.getItem('proceso_info');
    if (!info) return;

    const data = JSON.parse(info);

    const box = document.getElementById('info-proceso');
    box.innerHTML = `
    🚛 <strong>Placa:</strong> ${data.placa} <br>
    🏙 <strong>Origen:</strong> ${data.remitente} <br>
    🏢 <strong>Sede:</strong> ${data.sede} <br>
    📅 <strong>Fecha:</strong> ${data.fecha}
  `;
    box.style.display = 'block';
  }
  function normalizarTexto(texto) {
    return texto
      .toUpperCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "") // quitar tildes
      .replace(/\s+/g, " ")
      .trim();
  }

  // ===== Audio =====
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
    } catch (e) { }
  }
  document.body.addEventListener('click', initializeAudioContext, { once: true });

  // ===== Persistencia (progreso de escaneo) =====
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
    } catch (e) { }
  }
  restoreProgressFromLocalStorage();

  // ===== Sede / Check-in =====
  const sedeSelect = document.getElementById('sede');
  const sedeBadge = document.getElementById('sede-activa');

  if (sedeSelect) {
    const savedSede = localStorage.getItem(SEDE_STORAGE_KEY);
    if (savedSede) {
      sedeSelect.value = savedSede;
      if (sedeBadge) {
        sedeBadge.textContent = `✅ Sede actual: ${savedSede}`;
      }
    }
    sedeSelect.addEventListener('change', () => {
      const v = sedeSelect.value || '';
      localStorage.setItem(SEDE_STORAGE_KEY, v);
      if (sedeBadge) {
        sedeBadge.textContent = v
          ? `✅ Sede actual: ${v}`
          : '⚠️ Sin sede seleccionada';
      }
    });
  }

  // ===== Cargar archivo (cliente) desde Drive (CSV) =====
  document.getElementById('cargar-desde-drive').addEventListener('click', async () => {
    const fileId = document.getElementById('archivo-select').value;
    if (!fileId) {
      alert("Selecciona un cliente para cargar su archivo.");
      return;
    }
    // ================= CREAR PROCESO EN BD =================
    const placa = prompt("Placa del vehículo:");
    if (!placa) return;

    const remitente = prompt("Ciudad origen (ej: CUCUTA):");
    if (!remitente) return;

    const sede = localStorage.getItem(SEDE_STORAGE_KEY) || 'SIN SEDE';
    const fecha = new Date().toISOString().slice(0, 10);

    const crearProcesoResp = await fetch('https://exprecar.com/api/crear_proceso.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tipo: 'DESCARGUE',
        placa: placa.trim().toUpperCase(),
        sede: sede.toUpperCase(),
        remitente: remitente.trim().toUpperCase(),
        fecha_operativa: fecha
      })
    });

    const procesoData = await crearProcesoResp.json();

    if (!procesoData.ok) {
      alert("No se pudo crear el proceso");
      return;
    }

    const proceso_id = procesoData.proceso_id;
    console.log("Proceso creado:", proceso_id);
    // 🔒 Guardar proceso activo para usarlo al enviar escaneos
    localStorage.setItem('proceso_activo', String(proceso_id));

    // Guardar datos visibles del proceso
    localStorage.setItem('proceso_info', JSON.stringify({
      placa: placa.trim().toUpperCase(),
      remitente: remitente.trim().toUpperCase(),
      sede: sede.toUpperCase(),
      fecha: fecha
    }));

    mostrarInfoProceso();

    const exportUrl = `https://docs.google.com/spreadsheets/d/${fileId}/export?format=csv`;
    fetch(exportUrl)
      .then(r => {
        if (!r.ok) throw new Error("No se pudo acceder al archivo desde Drive.");
        return r.text();
      })
      .then(csvText => {
        Papa.parse(csvText, {
          header: true,
          skipEmptyLines: true,
          complete: async (results) => {
            products = results.data.map(item => {
              const codigoBarra = (item['codigo_barra'] || '').trim();        // Columna A
              const documentoTercero = (item['documento_tercero'] || '').trim();   // Columna D (puede venir vacía)
              const codigosAdicionales = (item['codigos_adicionales'] || '')
                .split(',')
                .map(s => s.trim())
                .filter(Boolean);

              // Siempre buscamos por A
              const codigos_validos = [codigoBarra];

              // 👇 Solo agregamos D si NO está vacío
              if (documentoTercero) {
                codigos_validos.push(documentoTercero);
              }

              // Y luego los adicionales
              codigosAdicionales.forEach(c => codigos_validos.push(c));

              return {
                codigo_barra: codigoBarra,
                documento_tercero: documentoTercero, // por si luego quieres mostrarlo
                cantidad: parseInt((item['cantidad'] || '0').trim(), 10),
                ciudad: (item['ciudad'] || '').trim(),
                codigos_validos,                      // A + (D si hay) + adicionales
                scannedSubcodes: [],
                noSufijoCount: 0
              };
            });

            scannedUnits = {};
            globalUnitsScanned = 0;
            totalUnits = products.reduce((acc, p) => acc + (p.cantidad || 0), 0);
            products.forEach(p => { scannedUnits[p.codigo_barra] = 0; });

            // ================= GUARDAR PLAN EN BD =================
            try {
              const respPlan = await fetch('https://exprecar.com/api/guardar_plan.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  proceso_id: proceso_id,
                  items: products.map(p => ({
                    codigo_base: p.codigo_barra,
                    unidades: p.cantidad,
                    ciudad: p.ciudad
                  }))
                })
              });

              const dataPlan = await respPlan.json();

              if (!dataPlan.ok) {
                alert("Error guardando el manifiesto");
                return;
              }

              console.log("Plan guardado correctamente");

            } catch (e) {
              console.error(e);
              alert("El manifiesto no se pudo guardar en la base");
            }

            updateScannedList();
            updateGlobalCounter();
            saveProgressToLocalStorage();

            // Bloquear selector (cliente cargado)
            const sel = document.getElementById('archivo-select');
            sel.disabled = true;
            document.getElementById('cargar-desde-drive').disabled = true;

            // Mostrar nombre de cliente
            const option = sel.selectedOptions[0];
            const box = document.getElementById('cliente-cargado');
            box.innerText = `📦 Cliente cargado: ${option.text}`;
            box.style.display = 'block';

            alert("Archivo cargado correctamente.");
          }

        });
      })
      .catch(err => alert("Error al cargar el archivo: " + err.message));
  });

  // ===== Escáner por input (pistola) =====
  document.getElementById('barcodeInput').addEventListener('input', () => {
    const val = document.getElementById('barcodeInput').value.trim();
    clearTimeout(barcodeTimeout);
    if (val !== '') {
      barcodeTimeout = setTimeout(() => {
        handleBarcodeScan(val);
        clearBarcodeInput();
      }, 1000);
    }
  });
  function clearBarcodeInput() {
    document.getElementById('barcodeInput').value = '';
  }

  function obtenerHoraFormateada() {
    const d = new Date();
    let h = d.getHours(), m = d.getMinutes(), s = d.getSeconds();
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    h = h ? h : 12;
    const pad = (n) => n < 10 ? '0' + n : n;
    return `${h}:${pad(m)}:${pad(s)} ${ampm}`;
  }

  // ===== Lógica de escaneo con comparación (conservando sufijo en el log) =====
  function handleBarcodeScan(scannedCode) {
    const rawCode = String(scannedCode || '').trim(); // código tal cual lo lee la pistola (con sufijo)
    const parts = rawCode.split('-');

    let main = (parts[0] || '').trim();
    main = main.replace(/^0+/, ''); // sin ceros iniciales para buscar en codigos_validos
    const sub = (parts[1] || '').trim();
    const now = obtenerHoraFormateada();

    // Buscar producto solo por el "main" sin ceros iniciales
    const p = products.find(x => x.codigos_validos.includes(main));

    if (p) {
      const cur = scannedUnits[p.codigo_barra] || 0;
      if (cur >= p.cantidad) {
        alert(`El producto ${main} ya alcanzó la cantidad total (${p.cantidad}).`);
        playTone(220, 400, 'square');
        clearBarcodeInput();
        return;
      }

      // Guardamos el código COMPLETO (con sufijo) en correctos
      codigosCorrectos.push({ codigo: rawCode, hora: now });

      if (sub === '' || p.cantidad === 1) {
        // Código sin sufijo (o solo 1 unidad)
        if (p.noSufijoCount < p.cantidad) {
          p.noSufijoCount += 1;
          scannedUnits[p.codigo_barra] += 1;
          globalUnitsScanned += 1;
          playTone(440, 180, 'sine');
        } else {
          alert(`El código ${main} ya fue escaneado ${p.cantidad} vez/veces.`);
          playTone(220, 400, 'square');
        }
      } else {
        // Código con sufijo → control por subcódigo
        if (!p.scannedSubcodes.includes(sub)) {
          p.scannedSubcodes.push(sub);
          scannedUnits[p.codigo_barra] += 1;
          globalUnitsScanned += 1;
          playTone(440, 180, 'sine');
        } else {
          alert(`El subcódigo -${sub} de ${main} ya fue escaneado.`);
          playTone(220, 400, 'square');
        }
      }

      updateScannedList(p.codigo_barra);
      updateGlobalCounter();
      saveProgressToLocalStorage();

    } else {
      // Código no encontrado → incorrecto, guardando completo
      playTone(220, 400, 'square');
      alert("El código escaneado no coincide con ningún producto.");
      codigosIncorrectos.push({ codigo: rawCode, hora: now });
      saveProgressToLocalStorage();
    }
    clearBarcodeInput();
  }

  // ===== UI =====
  function updateScannedList(scannedCode = '') {
    const ul = document.getElementById('scanned-list');
    ul.innerHTML = '';

    const sorted = products.slice().sort((a, b) => {
      if (a.codigo_barra === scannedCode) return -1;
      if (b.codigo_barra === scannedCode) return 1;
      return 0;
    });

    sorted.forEach(p => {
      const done = scannedUnits[p.codigo_barra] || 0;
      const pct = p.cantidad ? (done / p.cantidad) * 100 : 0;
      let cls = done === p.cantidad
        ? 'status-complete'
        : (done > 0 ? 'status-warning' : 'status-incomplete');
      const li = document.createElement('li');
      li.className = cls;
      li.innerHTML = `
        <span><strong>Códigos Adicionales:</strong> ${p.codigos_validos.join(', ')}</span><br>
        <span class="city"><strong>Ciudad:</strong> ${p.ciudad}</span>
        <div class="progress-bar">
          <div class="progress-bar-inner" style="width:${pct}%"></div>
        </div>
        <span class="progress-text">${done} de ${p.cantidad} unidades escaneadas</span>
      `;
      ul.appendChild(li);
    });
  }

  function updateGlobalCounter() {
    document.getElementById('global-counter').innerText =
      `Unidades descargadas: ${globalUnitsScanned} de ${totalUnits}`;
  }

  // ===== Abrir/Cerrar modal =====
  document.getElementById('finalizar-descarga').addEventListener('click', () => {
    const m = document.getElementById('modal');
    m.style.display = 'flex';
    document.getElementById('fecha').value = new Date().toISOString().slice(0, 10);
  });
  document.getElementById('cerrar-modal').addEventListener('click', () => {
    document.getElementById('modal').style.display = 'none';
  });

  // ===== Terminar proceso =====
  document.getElementById('terminar-proceso').addEventListener('click', function () {
    const ok = confirm("¿Estás seguro de que deseas finalizar el proceso? Esto eliminará todos los datos escaneados.");
    if (!ok) return;

    localStorage.removeItem('scanProgress');
    localStorage.removeItem('proceso_activo');
    products = [];
    scannedUnits = {};
    globalUnitsScanned = 0;
    totalUnits = 0;
    codigosCorrectos = [];
    codigosIncorrectos = [];

    const sel = document.getElementById('archivo-select');
    sel.disabled = false;
    sel.value = "";
    document.getElementById('cargar-desde-drive').disabled = false;

    const box = document.getElementById('cliente-cargado');
    box.innerText = '';
    box.style.display = 'none';

    // La sede permanece como check-in, no se borra aquí
    updateScannedList();
    updateGlobalCounter();
    saveProgressToLocalStorage();

    alert('Proceso finalizado. Los datos se han eliminado.');
  });

// ===== Enviar api =====
document.getElementById('generar-reporte').addEventListener('click', async () => {

  if (enviandoProceso) {
    alert("El proceso ya se está enviando...");
    return;
  }

  const firmaActual = generarFirmaDatos();

  if (firmaUltimoEnvio && firmaActual === firmaUltimoEnvio) {
    alert("Este descargue ya fue enviado y no tiene cambios.");
    return;
  }

  // 🔒 Obtener proceso activo creado al cargar el CSV
  const procesoActivo = localStorage.getItem('proceso_activo');

  if (!procesoActivo) {
    alert("No hay proceso activo. Debes cargar el informe primero.");
    return;
  }

  // ✅ permitimos enviar aunque haya solo incorrectos
  if (!codigosCorrectos.length && !codigosIncorrectos.length) {
    alert("No hay códigos para enviar.");
    return;
  }

  // ===== ARMAR UNIDADES (CORRECTOS + INCORRECTOS) =====
  const unidades = [];

  codigosCorrectos.forEach(c => {
    unidades.push({
      codigo: c.codigo,
      hora: c.hora,
      estado: "CORRECTO"
    });
  });

  codigosIncorrectos.forEach(c => {
    unidades.push({
      codigo: c.codigo,
      hora: c.hora,
      estado: "NO_PLANILLADO"
    });
  });

  const payload = {
    proceso_id: Number(procesoActivo),
    unidades: unidades
  };

  const btn = document.getElementById('generar-reporte');
  const original = btn.textContent;

  try {
    enviandoProceso = true;
    btn.disabled = true;
    btn.textContent = 'Enviando...';

    const resp = await fetch('https://exprecar.com/api/guardar_proceso.php', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    const data = await resp.json();
    if (!data.ok) throw new Error(data.error);

    firmaUltimoEnvio = firmaActual;

    alert(
      `Descargue guardado correctamente\n` +
      `Correctos: ${codigosCorrectos.length}\n` +
      `Incorrectos: ${codigosIncorrectos.length}\n` +
      `Total enviados: ${data.total_unidades}`
    );

    document.getElementById('modal').style.display = 'none';

  } catch (err) {
    console.error(err);
    alert("No se pudo guardar el proceso en la base de datos.");
  } finally {
    enviandoProceso = false;
    btn.disabled = false;
    btn.textContent = original;
  }

});
