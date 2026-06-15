const FirebaseDB = (() => {
  let initialized = false;
  let dbInstance = null;
  let remoteCallback = null;
  let unsubscriber = null;
  const COLLECTION = 'dashboard';
  const DOCUMENT = 'data';

  function init() {
    if (initialized) return;
    dbInstance = firebase.firestore();
    dbInstance.settings({ merge: true });
    initialized = true;
  }

  function getDocRef() {
    return dbInstance.collection(COLLECTION).doc(DOCUMENT);
  }

  async function saveData(data) {
    if (!initialized) return;
    try {
      await getDocRef().set(data);
    } catch (err) {
      console.error('[FirebaseDB] Error saving:', err);
    }
  }

  async function loadData() {
    if (!initialized) return null;
    try {
      const doc = await getDocRef().get();
      return doc.exists ? doc.data() : null;
    } catch (err) {
      console.error('[FirebaseDB] Error loading:', err);
      return null;
    }
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
