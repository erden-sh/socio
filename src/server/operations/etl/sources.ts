/**
 * The run sources the analytics process knows (CB-187): the registry's
 * own, and every module's that registers one. A module that adds a source
 * registers it in a file of its own, imported by its module and here
 * (the analytics process doesn't load the app's modules).
 */
import '@socio/foundation/telegram/run-source';
