import { compareText } from '../locale.js';

/**
 * Dictation language (CB-221): one person's hint to the transcription
 * server, in Settings → Account. Auto (the default, stored as null or
 * nothing) sends no language at all, so the server detects it; a language
 * goes as its bare ISO code, the `language` field of an upload
 * (`POST /v1/audio/transcriptions`) and `input_audio_transcription.language`
 * in a realtime session's update (live text, CB-222; self-hosted calls,
 * CB-265).
 *
 * The codes are the ones socio-voice takes: Whisper large-v3-turbo's, with
 * English names, less two. Nynorsk (`nn`) isn't offered: the server folds
 * it into Norwegian (`no`). Javanese (`jw`) isn't either: socio-voice 0.6.0
 * maps that code wrongly, so the hint would break transcription; add it
 * back once socio-voice's alias fix ships.
 */
export const DICTATION_LANGUAGES = {
    en: 'English',
    zh: 'Chinese',
    de: 'German',
    es: 'Spanish',
    ru: 'Russian',
    ko: 'Korean',
    fr: 'French',
    ja: 'Japanese',
    pt: 'Portuguese',
    tr: 'Turkish',
    pl: 'Polish',
    ca: 'Catalan',
    nl: 'Dutch',
    ar: 'Arabic',
    sv: 'Swedish',
    it: 'Italian',
    id: 'Indonesian',
    hi: 'Hindi',
    fi: 'Finnish',
    vi: 'Vietnamese',
    he: 'Hebrew',
    uk: 'Ukrainian',
    el: 'Greek',
    ms: 'Malay',
    cs: 'Czech',
    ro: 'Romanian',
    da: 'Danish',
    hu: 'Hungarian',
    ta: 'Tamil',
    no: 'Norwegian',
    th: 'Thai',
    ur: 'Urdu',
    hr: 'Croatian',
    bg: 'Bulgarian',
    lt: 'Lithuanian',
    la: 'Latin',
    mi: 'Maori',
    ml: 'Malayalam',
    cy: 'Welsh',
    sk: 'Slovak',
    te: 'Telugu',
    fa: 'Persian',
    lv: 'Latvian',
    bn: 'Bengali',
    sr: 'Serbian',
    az: 'Azerbaijani',
    sl: 'Slovenian',
    kn: 'Kannada',
    et: 'Estonian',
    mk: 'Macedonian',
    br: 'Breton',
    eu: 'Basque',
    is: 'Icelandic',
    hy: 'Armenian',
    ne: 'Nepali',
    mn: 'Mongolian',
    bs: 'Bosnian',
    kk: 'Kazakh',
    sq: 'Albanian',
    sw: 'Swahili',
    gl: 'Galician',
    mr: 'Marathi',
    pa: 'Punjabi',
    si: 'Sinhala',
    km: 'Khmer',
    sn: 'Shona',
    yo: 'Yoruba',
    so: 'Somali',
    af: 'Afrikaans',
    oc: 'Occitan',
    ka: 'Georgian',
    be: 'Belarusian',
    tg: 'Tajik',
    sd: 'Sindhi',
    gu: 'Gujarati',
    am: 'Amharic',
    yi: 'Yiddish',
    lo: 'Lao',
    uz: 'Uzbek',
    fo: 'Faroese',
    ht: 'Haitian Creole',
    ps: 'Pashto',
    tk: 'Turkmen',
    mt: 'Maltese',
    sa: 'Sanskrit',
    lb: 'Luxembourgish',
    my: 'Myanmar',
    bo: 'Tibetan',
    tl: 'Tagalog',
    mg: 'Malagasy',
    as: 'Assamese',
    tt: 'Tatar',
    haw: 'Hawaiian',
    ln: 'Lingala',
    ha: 'Hausa',
    ba: 'Bashkir',
    su: 'Sundanese',
    yue: 'Cantonese',
} as const satisfies Record<string, string>;
export type DictationLanguage = keyof typeof DICTATION_LANGUAGES;

/** Whether a value is a language the transcription server takes as a hint. */
export function isDictationLanguage(value: unknown): value is DictationLanguage {
    return typeof value === 'string' && Object.hasOwn(DICTATION_LANGUAGES, value);
}

/** Every code, for the API's validation. */
export const DICTATION_LANGUAGE_CODES = Object.keys(DICTATION_LANGUAGES) as DictationLanguage[];

/** The select's languages, by English name (Auto goes first, apart). */
export const DICTATION_LANGUAGE_OPTIONS = DICTATION_LANGUAGE_CODES.map((code) => ({
    code,
    name: DICTATION_LANGUAGES[code],
})).sort((a, b) => compareText(a.name, b.name));

/**
 * The hint for a stored preference: the code when it is one the server
 * takes; undefined for Auto, and for anything else (a code this list no
 * longer has is Auto, never sent).
 */
export function dictationLanguageHint(stored: unknown): DictationLanguage | undefined {
    return isDictationLanguage(stored) ? stored : undefined;
}
