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
      const resp = await fetch(getRestUrl());
      if (!resp.ok) {
        console.warn('[FirebaseDB] REST API error:', resp.status, resp.statusText);
        return null;
      }
      const doc = await resp.json();
      if (!doc.fields) return null;
      return convertFirestoreFields(doc.fields);
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
        const doc = await getDocRef().get();
        if (doc.exists) return doc.data();
      } catch (err) {
        console.warn('[FirebaseDB] SDK load falló, intentando REST API:', err);
      }
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
