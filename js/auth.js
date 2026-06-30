/**
 * auth.js — Módulo de Autenticación Firebase
 * ============================================
 */

const Auth = (() => {

  let currentUser = null;
  let stateListeners = [];

  /**
   * Inicializa el listener de estado de autenticación.
   */
  function init() {
    firebase.auth().onAuthStateChanged((user) => {
      currentUser = user;
      stateListeners.forEach(cb => cb(user));
    });
  }

  /**
   * Registra un callback para cambios en el estado de autenticación.
   * @param {Function} cb - Recibe el usuario (o null)
   */
  function onAuthChange(cb) {
    stateListeners.push(cb);
  }

  /**
   * Inicia sesión con email y contraseña.
   * @param {string} email
   * @param {string} password
   * @returns {Promise}
   */
  function signIn(email, password) {
    return firebase.auth().signInWithEmailAndPassword(email, password);
  }

  /**
   * Cierra la sesión.
   * @returns {Promise}
   */
  function signOut() {
    return firebase.auth().signOut();
  }

  /**
   * Indica si hay un usuario autenticado.
   * @returns {boolean}
   */
  function isAuthenticated() {
    return !!currentUser;
  }

  return { init, onAuthChange, signIn, signOut, isAuthenticated };

})();
