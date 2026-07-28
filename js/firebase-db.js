const FirebaseDB = (() => {
  let initialized = false;
  let dbInstance = null;
  let remoteCallback = null;
  let unsubscriber = null;
  const COLLECTION = 'dashboard';
  const DOCUMENT = 'data';

  const PROJECT_ID = 'efectividad';

  function getRestUrl() {
    return `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents/${COLLECTION}/${DOCUMENT}`;
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

  function getDocRef() {
    return dbInstance.collection(COLLECTION).doc(DOCUMENT);
  }

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

  async function loadDataViaRest() {
    try {
      const url = getRestUrl();
      console.log('[FirebaseDB] REST fallback fetching:', url);
      const resp = await fetch(url);
      if (!resp.ok) {
        console.warn('[FirebaseDB] REST API error:', resp.status, resp.statusText);
        return null;
      }
      const doc = await resp.json();
      console.log('[FirebaseDB] REST API response:', doc ? 'received' : 'empty', doc && doc.fields ? Object.keys(doc.fields) : 'no fields');
      if (!doc.fields) return null;
      const converted = convertFirestoreFields(doc.fields);
      console.log('[FirebaseDB] REST converted, programmers:', converted.programmers ? Object.keys(converted.programmers) : 'none');
      return converted;
    } catch (err) {
      console.warn('[FirebaseDB] REST API fallback falló:', err);
      return null;
    }
  }

  async function saveData(data) {
    if (!initialized) {
      console.warn('[FirebaseDB] SDK no disponible, no se puede guardar');
      return;
    }
    try {
      await getDocRef().set(data);
    } catch (err) {
      console.error('[FirebaseDB] Error saving:', err);
    }
  }

  async function loadData() {
    if (initialized) {
      try {
        console.log('[FirebaseDB] SDK loadData...');
        const doc = await getDocRef().get();
        console.log('[FirebaseDB] SDK loadData done, exists:', doc.exists);
        if (doc.exists) return doc.data();
      } catch (err) {
        console.warn('[FirebaseDB] SDK load falló, intentando REST API:', err);
      }
    } else {
      console.log('[FirebaseDB] SDK not initialized, using REST API');
    }
    return loadDataViaRest();
  }

  function onRemoteChange(callback) {
    remoteCallback = callback;
    if (!initialized) return;
    if (unsubscriber) unsubscriber();
    unsubscriber = getDocRef().onSnapshot(snapshot => {
      if (snapshot.exists && remoteCallback) {
        remoteCallback(snapshot.data());
      }
    }, err => {
      console.error('[FirebaseDB] Listener error:', err);
    });
  }

  function disconnect() {
    if (unsubscriber) {
      unsubscriber();
      unsubscriber = null;
    }
    remoteCallback = null;
  }

  function isAvailable() {
    return initialized;
  }

  return { init, saveData, loadData, onRemoteChange, disconnect, isAvailable };
})();
