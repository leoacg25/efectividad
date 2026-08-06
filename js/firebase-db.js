/**
 * firebase-db.js — Capa de sincronización con Firestore
 * =======================================================
 *
 * ESQUEMA (v2):
 *   - Colección "programmers":
 *       doc id = encodeURIComponent(nombre del programador)
 *       { tickets: [...], profile: 'desarrollador' }
 *   - Colección "dashboard", documento "meta":
 *       { periodName, loadedAt, archives, planifications }
 *
 * Ventajas frente al esquema v1 (un solo documento dashboard/data):
 *   - Cada programador es un documento independiente: editar las notas o el
 *     estado de un ticket de un programador NO sobrescribe los datos de los
 *     demás (antes, el último escritor ganaba sobre TODO el documento).
 *   - Se escribe únicamente el documento que cambió (menos tráfico).
 *   - Los ecos de onSnapshot de escrituras propias se ignoran: se evita el
 *     bucle set() → onSnapshot → set().
 *
 * MIGRACIÓN: si aún existe el documento antiguo "dashboard/data", al cargar
 * se divide en el esquema v2 automáticamente.
 */

const FirebaseDB = (() => {
  let initialized = false;
  let dbInstance = null;
  let remoteCallback = null;
  let unsubscribers = [];
  let saveChain = Promise.resolve();

  const PROJECT_ID = 'efectividad';
  const PROGRAMMERS_COLLECTION = 'programmers';
  const META_COLLECTION = 'dashboard';
  const META_DOC = 'meta';
  const POSWEB_DOC = 'posweb';
  const LEGACY_COLLECTION = 'dashboard';
  const LEGACY_DOC = 'data';

  // Cache del último estado conocido (local + remoto). Sirve para:
  //   - Calcular qué documentos cambiaron y escribir solo esos.
  //   - Reconstruir el objeto completo al recibir snapshots.
  // IMPORTANTE: el cache SIEMPRE guarda copias independientes (deep copy),
  // nunca referencias a las arrays que maneja la UI, para que el diff de
  // computeWrites detecte las mutaciones hechas en el estado de la app.
  const cached = {
    programmers: {}, // name -> { tickets: [], profile: 'desarrollador' }
    meta: null,      // { periodName, loadedAt, archives, planifications }
    posweb: null,    // { programmer: '', cases: [] }
  };
  let lastSnapshotJson = null;

  function getRestUrl(collection, doc) {
    return `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${collection}${doc ? `/${doc}` : ''}`;
  }

  function init() {
    if (initialized) return;
    try {
      dbInstance = firebase.firestore();
      dbInstance.settings({ merge: true });
      initialized = true;
    } catch (e) {
      console.warn('[FirebaseDB] Firestore SDK no disponible, se usará REST API:', e);
    }
  }

  function encodeName(name) {
    return encodeURIComponent(String(name));
  }

  function decodeName(id) {
    try {
      return decodeURIComponent(id);
    } catch (e) {
      return id;
    }
  }

  function getProgrammerDocRef(name) {
    return dbInstance.collection(PROGRAMMERS_COLLECTION).doc(encodeName(name));
  }

  function getMetaDocRef() {
    return dbInstance.collection(META_COLLECTION).doc(META_DOC);
  }

  function getPosWebDocRef() {
    return dbInstance.collection(META_COLLECTION).doc(POSWEB_DOC);
  }

  function getLegacyDocRef() {
    return dbInstance.collection(LEGACY_COLLECTION).doc(LEGACY_DOC);
  }

  // ----------------------------------------------------------------
  // CONVERSIÓN DE VALORES FIRESTORE (REST)
  // ----------------------------------------------------------------

  function convertFirestoreValue(value) {
    if (value === null || value === undefined) return null;
    if (value.stringValue !== undefined) return value.stringValue;
    if (value.integerValue !== undefined) return Number(value.integerValue);
    if (value.doubleValue !== undefined) return Number(value.doubleValue);
    if (value.booleanValue !== undefined) return value.booleanValue;
    if (value.nullValue !== undefined) return null;
    if (value.arrayValue !== undefined) {
      return (value.arrayValue.values || []).map(v => convertFirestoreValue(v));
    }
    if (value.mapValue !== undefined) {
      return convertFirestoreFields(value.mapValue.fields || {});
    }
    if (value.timestampValue !== undefined) return value.timestampValue;
    if (value.referenceValue !== undefined) return value.referenceValue;
    if (value.geoPointValue !== undefined) return value.geoPointValue;
    if (value.bytesValue !== undefined) return value.bytesValue;
    return value;
  }

  function convertFirestoreFields(fields) {
    const result = {};
    Object.keys(fields).forEach(key => {
      result[key] = convertFirestoreValue(fields[key]);
    });
    return result;
  }

  // ----------------------------------------------------------------
  // ESTADO EN CACHE
  // ----------------------------------------------------------------

  function extractProgrammerDoc(data, name) {
    const tickets = Array.isArray(data.programmers?.[name]) ? data.programmers[name] : [];
    return {
      tickets: JSON.parse(JSON.stringify(tickets)),
      profile: data.profiles?.[name] || 'desarrollador',
    };
  }

  function extractMeta(data) {
    return {
      periodName: data.periodName || '',
      loadedAt: data.loadedAt || null,
      archives: Array.isArray(data.archives) ? JSON.parse(JSON.stringify(data.archives)) : [],
      planifications: Array.isArray(data.planifications) ? JSON.parse(JSON.stringify(data.planifications)) : [],
    };
  }

  function extractPosWeb(data) {
    const pos = data && data.posweb;
    return {
      programmer: pos?.programmer || '',
      cases: Array.isArray(pos?.cases) ? JSON.parse(JSON.stringify(pos.cases)) : [],
    };
  }

  function buildDataFromCache() {
    const programmers = {};
    const profiles = {};
    Object.entries(cached.programmers).forEach(([name, doc]) => {
      programmers[name] = JSON.parse(JSON.stringify(Array.isArray(doc.tickets) ? doc.tickets : []));
      profiles[name] = doc.profile || 'desarrollador';
    });
    const meta = cached.meta || {};
    return {
      programmers,
      profiles,
      periodName: meta.periodName || '',
      loadedAt: meta.loadedAt || null,
      archives: Array.isArray(meta.archives) ? JSON.parse(JSON.stringify(meta.archives)) : [],
      planifications: Array.isArray(meta.planifications) ? JSON.parse(JSON.stringify(meta.planifications)) : [],
      posweb: cached.posweb ? {
        programmer: cached.posweb.programmer || '',
        cases: Array.isArray(cached.posweb.cases) ? JSON.parse(JSON.stringify(cached.posweb.cases)) : [],
      } : null,
    };
  }

  function refreshLastSnapshotJson() {
    lastSnapshotJson = JSON.stringify(buildDataFromCache());
  }

  /**
   * Calcula las escrituras necesarias para llevar el cache al estado de `data`.
   * @param {Object} data - Objeto completo { programmers, profiles, ... }
   * @returns {Array} [{ type, ref, payload }]
   */
  function computeWrites(data) {
    const writes = [];

    const newProg = {};
    Object.keys(data.programmers || {}).forEach(name => {
      newProg[name] = extractProgrammerDoc(data, name);
    });

    const allNames = new Set([...Object.keys(cached.programmers), ...Object.keys(newProg)]);
    allNames.forEach(name => {
      const cachedDoc = cached.programmers[name];
      const nextDoc = newProg[name];
      if (!nextDoc) {
        if (cachedDoc) writes.push({ type: 'delete', ref: getProgrammerDocRef(name) });
      } else if (!cachedDoc || JSON.stringify(cachedDoc) !== JSON.stringify(nextDoc)) {
        writes.push({ type: 'set', ref: getProgrammerDocRef(name), payload: nextDoc });
      }
    });

    const nextMeta = extractMeta(data);
    if (!cached.meta || JSON.stringify(cached.meta) !== JSON.stringify(nextMeta)) {
      writes.push({ type: 'set', ref: getMetaDocRef(), payload: nextMeta });
    }

    // Pos Web solo se escribe cuando el estado local lo incluye (p. ej. en
    // importaciones sin posweb se conserva el valor remoto en la nube).
    const hasPosWebData = !!(data && data.posweb && typeof data.posweb === 'object');
    if (hasPosWebData) {
      const nextPosWeb = extractPosWeb(data);
      if (!cached.posweb || JSON.stringify(cached.posweb) !== JSON.stringify(nextPosWeb)) {
        writes.push({ type: 'set', ref: getPosWebDocRef(), payload: nextPosWeb });
      }
    }

    return writes;
  }

  /**
   * Aplica optimistamente el estado de `data` al cache y refresca el
   * snapshot de referencia para ignorar el eco de las escrituras propias.
   */
  function applyLocalToCache(data) {
    const newProg = {};
    Object.keys(data.programmers || {}).forEach(name => {
      newProg[name] = extractProgrammerDoc(data, name);
    });
    cached.programmers = newProg;
    cached.meta = extractMeta(data);
    if (data && data.posweb && typeof data.posweb === 'object') {
      cached.posweb = extractPosWeb(data);
    }
    refreshLastSnapshotJson();
  }

  // ----------------------------------------------------------------
  // GUARDADO
  // ----------------------------------------------------------------

  /**
   * Guarda los cambios locales escribiendo SOLO los documentos que cambiaron.
   * Serializa las escrituras para mantener un orden consistente.
   * @param {Object} data - Objeto completo de datos
   * @returns {Promise<boolean>} true si todo se guardó en Firestore
   */
  function saveData(data) {
    const run = async () => {
      if (!initialized) {
        console.warn('[FirebaseDB] SDK no disponible, no se puede guardar');
        return false;
      }

      const writes = computeWrites(data);
      if (writes.length === 0) return true;

      // Guardar previo estado por si falla alguna escritura
      const prevProgrammers = cached.programmers;
      const prevMeta = cached.meta;
      const prevPosWeb = cached.posweb;
      const prevSnapshotJson = lastSnapshotJson;

      applyLocalToCache(data);

      try {
        await Promise.all(writes.map(w => {
          if (w.type === 'delete') return w.ref.delete();
          return w.ref.set(w.payload);
        }));
        return true;
      } catch (err) {
        console.error('[FirebaseDB] Error saving:', err);
        // Revertir cache para que el próximo guardado reintente los docs fallidos
        cached.programmers = prevProgrammers;
        cached.meta = prevMeta;
        cached.posweb = prevPosWeb;
        lastSnapshotJson = prevSnapshotJson;
        return false;
      }
    };

    const result = saveChain.then(run, run);
    saveChain = result.then(() => {}, () => {});
    return result;
  }

  // ----------------------------------------------------------------
  // CARGA
  // ----------------------------------------------------------------

  /**
   * Carga el estado completo desde Firestore.
   * Migra automáticamente el esquema antiguo (dashboard/data) si existe.
   * @returns {Promise<Object|null>}
   */
  async function loadData() {
    if (!initialized) return loadDataViaRest();

    try {
      // 1) Esquema v2
      const progSnap = await dbInstance.collection(PROGRAMMERS_COLLECTION).get();
      const metaSnap = await getMetaDocRef().get();
      const poswebSnap = await getPosWebDocRef().get();

      if (progSnap.size > 0 || metaSnap.exists || poswebSnap.exists) {
        cached.programmers = {};
        progSnap.forEach(doc => {
          cached.programmers[decodeName(doc.id)] = doc.data();
        });
        cached.meta = metaSnap.exists ? metaSnap.data() : null;
        cached.posweb = poswebSnap.exists ? poswebSnap.data() : null;
        refreshLastSnapshotJson();
        return buildDataFromCache();
      }

      // 2) Migración desde esquema v1 (documento único)
      const legacySnap = await getLegacyDocRef().get();
      if (legacySnap.exists) {
        await migrateLegacy(legacySnap.data());
        refreshLastSnapshotJson();
        return buildDataFromCache();
      }

      // 3) Base de datos vacía
      cached.programmers = {};
      cached.meta = null;
      cached.posweb = null;
      refreshLastSnapshotJson();
      return buildDataFromCache();
    } catch (err) {
      console.warn('[FirebaseDB] SDK load falló, intentando REST API:', err);
      return loadDataViaRest();
    }
  }

  /**
   * Divide el documento antiguo { programmers, profiles, ... } en el
   * esquema v2 y lo escribe en Firestore.
   * @param {Object} legacy
   */
  async function migrateLegacy(legacy) {
    const programmers = legacy.programmers || {};
    const profiles = legacy.profiles || {};
    const writes = [];

    Object.keys(programmers).forEach(name => {
      const doc = {
        tickets: Array.isArray(programmers[name]) ? JSON.parse(JSON.stringify(programmers[name])) : [],
        profile: profiles[name] || 'desarrollador',
      };
      cached.programmers[name] = doc;
      writes.push(getProgrammerDocRef(name).set(doc));
    });

    cached.meta = {
      periodName: legacy.periodName || '',
      loadedAt: legacy.loadedAt || null,
      archives: Array.isArray(legacy.archives) ? JSON.parse(JSON.stringify(legacy.archives)) : [],
      planifications: Array.isArray(legacy.planifications) ? JSON.parse(JSON.stringify(legacy.planifications)) : [],
    };
    writes.push(getMetaDocRef().set(cached.meta));

    if (legacy.posweb && typeof legacy.posweb === 'object') {
      cached.posweb = {
        programmer: legacy.posweb.programmer || '',
        cases: Array.isArray(legacy.posweb.cases) ? JSON.parse(JSON.stringify(legacy.posweb.cases)) : [],
      };
      writes.push(getPosWebDocRef().set(cached.posweb));
    }

    await Promise.all(writes);
    console.log('[FirebaseDB] Migración a documentos por programador completada');
  }

  // ----------------------------------------------------------------
  // LISTENER EN TIEMPO REAL
  // ----------------------------------------------------------------

  /**
   * Suscribe callbacks a los cambios remotos. Se ignoran los ecos de las
   * escrituras locales para evitar bucles de escritura.
   * @param {Function} callback - Recibe el objeto completo de datos
   */
  function onRemoteChange(callback) {
    remoteCallback = callback;
    if (!initialized) return;

    if (unsubscribers.length) {
      unsubscribers.forEach(u => u());
      unsubscribers = [];
    }

    const progUnsub = dbInstance.collection(PROGRAMMERS_COLLECTION).onSnapshot(snapshot => {
      snapshot.docChanges().forEach(change => {
        const name = decodeName(change.doc.id);
        if (change.type === 'removed') {
          delete cached.programmers[name];
        } else {
          cached.programmers[name] = change.doc.data();
        }
      });
      handleRemoteSnapshot();
    }, err => {
      console.error('[FirebaseDB] Listener programadores error:', err);
    });

    const metaUnsub = getMetaDocRef().onSnapshot(snapshot => {
      cached.meta = snapshot.exists ? snapshot.data() : null;
      handleRemoteSnapshot();
    }, err => {
      console.error('[FirebaseDB] Listener meta error:', err);
    });

    const poswebUnsub = getPosWebDocRef().onSnapshot(snapshot => {
      cached.posweb = snapshot.exists ? snapshot.data() : null;
      handleRemoteSnapshot();
    }, err => {
      console.error('[FirebaseDB] Listener posweb error:', err);
    });

    unsubscribers = [progUnsub, metaUnsub, poswebUnsub];
  }

  function handleRemoteSnapshot() {
    const json = JSON.stringify(buildDataFromCache());
    if (json === lastSnapshotJson) return;
    lastSnapshotJson = json;
    if (remoteCallback) remoteCallback(buildDataFromCache());
  }

  function disconnect() {
    unsubscribers.forEach(u => u());
    unsubscribers = [];
    remoteCallback = null;
  }

  function isAvailable() {
    return initialized;
  }

  // ----------------------------------------------------------------
  // FALLBACK REST (solo lectura)
  // ----------------------------------------------------------------

  async function loadDataViaRest() {
    try {
      const progUrl = getRestUrl(PROGRAMMERS_COLLECTION);
      const progResp = await fetch(progUrl);
      if (!progResp.ok) {
        console.warn('[FirebaseDB] REST programadores error:', progResp.status);
        return null;
      }
      const progBody = await progResp.json();
      const docs = progBody.documents || [];

      // Esquema v2
      if (docs.length > 0) {
        const programmers = {};
        const profiles = {};
        docs.forEach(d => {
          const name = decodeName(d.name.split('/').pop());
          const fields = convertFirestoreFields(d.fields || {});
          programmers[name] = Array.isArray(fields.tickets) ? fields.tickets : [];
          profiles[name] = fields.profile || 'desarrollador';
        });

        let meta = {};
        const metaResp = await fetch(getRestUrl(META_COLLECTION, META_DOC));
        if (metaResp.ok) {
          const metaBody = await metaResp.json();
          if (metaBody.fields) meta = convertFirestoreFields(metaBody.fields);
        }

        let posweb = null;
        const poswebResp = await fetch(getRestUrl(META_COLLECTION, POSWEB_DOC));
        if (poswebResp.ok) {
          const poswebBody = await poswebResp.json();
          if (poswebBody.fields) posweb = convertFirestoreFields(poswebBody.fields);
        }

        return {
          programmers,
          profiles,
          periodName: meta.periodName || '',
          loadedAt: meta.loadedAt || null,
          archives: Array.isArray(meta.archives) ? meta.archives : [],
          planifications: Array.isArray(meta.planifications) ? meta.planifications : [],
          posweb: posweb && typeof posweb === 'object' ? {
            programmer: posweb.programmer || '',
            cases: Array.isArray(posweb.cases) ? posweb.cases : [],
          } : null,
        };
      }

      // Esquema v1 (lectura directa para compatibilidad)
      const legacyResp = await fetch(getRestUrl(LEGACY_COLLECTION, LEGACY_DOC));
      if (legacyResp.ok) {
        const legacyBody = await legacyResp.json();
        if (legacyBody.fields) return convertFirestoreFields(legacyBody.fields);
      }

      return null;
    } catch (err) {
      console.warn('[FirebaseDB] REST API fallback falló:', err);
      return null;
    }
  }

  return { init, saveData, loadData, onRemoteChange, disconnect, isAvailable };
})();
