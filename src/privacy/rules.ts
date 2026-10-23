import { ORG_CI, ORG_CS_USED, ORG_SUF, LOC_GAZ, wordRe } from "./gazetteer.js";

const MONTHS = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|June?|July?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";
const MONTHS_X = "janvier|février|fevrier|mars|avril|mai|juin|juillet|août|aout|septembre|octobre|novembre|décembre|decembre|enero|febrero|marzo|abril|mayo|junio|julio|agosto|septiembre|setiembre|noviembre|diciembre|Januar|Februar|März|Maerz|April|Juni|Juli|August|September|Oktober|November|Dezember|gennaio|febbraio|aprile|maggio|giugno|luglio|settembre|ottobre|dicembre";
const STREET = "Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Boulevard|Blvd|Court|Crescent|Cres|Way|Place|Pl";
const STREET_X = "Terrace|Close|Gardens|Parkway|Trail|Gate|Row|Mews|Circle|Heights|Square|Grove|Highway|Hwy";
const NUMWORD = "zero|oh|one|two|three|four|five|six|seven|eight|nine";

/** [type, pattern, src override] */
export type Rule = [string, RegExp, string?];

export const RULES_LEGACY: Rule[] = [
  ["EMAIL", /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g],
  ["URL", /\bhttps?:\/\/[^\s<>"')]*[^\s<>"').,;:!?]/g],
  ["ID", /\b\d{3}-\d{2}-\d{4}\b/g],
  ["ID", /\b(?:\d{4}[ -]){3}\d{4}\b/g],
  ["ID", /\b\d{4}-\d{3}-\d{3}\b/g],
  ["ID", /\b\d{3}[ -]\d{3}[ -]\d{3}\b/g],
  ["ID", /\b[A-Z]{2}\d{6,8}\b/g],
  ["ID", /\b[A-Z]{2,4}-\d{5,}\b/g],
  ["PHONE", /(?<![\d-])(?:\+?1[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}(?!\d)/g],
  ["DATE", /\b\d{4}-\d{2}-\d{2}\b/g],
  ["DATE", /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g],
  ["DATE", new RegExp("\\b(?:" + MONTHS + ")\\.? \\d{1,2}(?:st|nd|rd|th)?(?:,? \\d{4})?\\b", "g")],
  ["DATE", new RegExp("\\b\\d{1,2}(?:st|nd|rd|th)? (?:of )?(?:" + MONTHS + ")(?:,? \\d{4})?\\b", "g")],
  ["DATE", new RegExp("\\b(?:" + MONTHS + ") \\d{4}\\b", "g")],
  ["ADDRESS", new RegExp("\\b\\d{1,5} (?:[A-Z][a-z]+ ){1,3}(?:" + STREET + ")\\b(?: (?:West|East|North|South|W|E|N|S)\\b)?", "g")],
  ["ADDRESS", /\b[A-Z]\d[A-Z] ?\d[A-Z]\d\b/g],
  ["HANDLE", /(?<![\w.])@[A-Za-z0-9_][A-Za-z0-9_.]{1,29}\b/g],
];

const CUES = "confirmation|booking|reservation|reference|ref|order|tracking|ticket|invoice|case|claim|policy|account|acct|member(?:ship)?|licen[cs]e|passport|health card|card|rx|prescription|pnr|passcode|pin|otp|code";

/** Hard identifier rules (priority over everything except deny). */
export const RULES_NEW: Rule[] = [
  ["ID", /\b[A-Z]{2,5}-\d{2,}(?:-\d+)+\b/g],
  ["ID", /\b[A-Z]{2,5}-\d{5,}\b/g],
  ["ID", /\b\d{4} \d{4} \d{4}\b/g],
  ["ID", /\b[A-Z]{2}\s?\d{2}\s?\d{2}\s?\d{2}\s?[A-D]\b/g],
  ["ID", /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,4})?\b/g],
  ["ID", /\b(?:\d{1,3}\.){3}\d{1,3}\b/g],
  ["ID", /\b(?=[A-Z0-9]*\d)(?=[A-Z0-9]*[A-Z].*[A-Z])[A-Z0-9]{6,20}\b/g],
  ["ID", new RegExp("(?<=\\b(?:" + CUES + ")\\b(?:\\s+(?:code|number|no\\.?|num|id|is|was|are|:|#|-))*\\s*[:#]?\\s*)(?:(?=[A-Za-z0-9-]*[A-Za-z])(?=[A-Za-z0-9-]*\\d)[A-Za-z0-9][A-Za-z0-9-]{3,}|\\d[\\d-]{4,}\\d)(?![\\w-])", "gi")],
  ["POSTAL", /\b[A-Z]{1,2}\d[A-Z\d]? ?\d[A-Z]{2}\b/g],
  ["PHONE", /(?<![\w])\+\d{1,3}(?:[\s.-]?\(?\d{1,5}\)?){2,5}(?!\d)/g],
  ["PHONE", /(?<!\d)0[1-9](?:[ .]\d{2}){4}(?!\d)/g],
  ["PHONE", /(?<!\d)0\d{2}[-\s]\d{3}[-\s]\d{2}[-\s]\d{2}(?!\d)/g],
  ["PHONE", /(?<!\d)0\d{4}\s?\d{6}(?!\d)/g],
  ["PHONE", new RegExp("\\b(?:" + NUMWORD + ")(?:[\\s,.-]+(?:" + NUMWORD + ")){6,}\\b", "gi")],
  ["EMAIL", /\b[A-Za-z0-9]+(?: (?:dot|underscore|dash) [A-Za-z0-9]+)* at [A-Za-z0-9]+(?: dot [A-Za-z0-9]+)+\b/g],
  ["DATE", /\b\d{1,2}\.\d{1,2}\.\d{2,4}\b/g],
  ["DATE", new RegExp("(?<![\\p{L}\\p{N}])\\d{1,2}(?:\\.|º|er)?\\s+(?:de\\s+)?(?:" + MONTHS_X + ")(?:\\s+(?:de\\s+)?\\d{4})?(?![\\p{L}])", "giu")],
  ["ADDRESS", new RegExp("\\b\\d{1,5} (?:[A-Z][a-z]+ ){1,3}(?:" + STREET_X + ")\\b", "g")],
  ["ADDRESS", /\b(?:Calle|Avenida|Paseo|Camino|Carrer|Via|Viale|Piazza)\s+(?:(?:de|del|della|di|la|los|las)\s+)?\p{Lu}\p{L}+(?:\s+\p{Lu}\p{L}+)*,?\s+\d{1,4}\b/gu],
  ["ADDRESS", /\b\p{Lu}\p{L}+(?:straße|strasse|weg|gasse|platz|allee)\s+\d{1,4}[a-z]?\b/gu],
];

// ---- heuristics (same priority as the NER; longest wins) ----
const TITLES = "Mr|Mrs|Ms|Mx|Dr|Prof|Officer|Coach|Principal|Nurse|Auntie|Aunt|Uncle|Grandma|Grandpa|Grandad|Nana|Nonna|Papa|Mama|Mam|Herr|Frau|Madame|Monsieur|Señor|Señora|Sra|Sr|Mme";
const NAME1 = "\\p{Lu}\\p{L}+(?:(?:-|['’])\\p{Lu}\\p{L}+)*";
const NAME = NAME1 + "(?:\\s" + NAME1 + ")?";
const REL = "sister|brother|mom|mum|mother|dad|father|wife|husband|partner|son|daughter|cousin|uncle|aunt|auntie|friend|boss|colleague|coworker|neighbou?r|roommate|girlfriend|boyfriend|fianc[ée]e?|grandma|grandpa|grandmother|grandfather|nephew|niece|dog|cat|puppy|kitten|poodle|ex|manager|teacher|therapist|doctor|landlord|landlady|stepdad|stepmom|twin|hermana|hermano|prima|primo|amiga|amigo|jefa|jefe|tía|tío";

export const RULES_HEUR: Rule[] = [
  ["PERSON", new RegExp("(?<=\\b(?:" + TITLES + ")\\.?\\s+)" + NAME, "gu"), "heur"],
  ["PERSON", new RegExp("(?<=(?:[Mm]y|[Oo]ur|[Hh]is|[Hh]er|[Tt]heir|[Yy]our|[Mm]i|[Mm]on|[Mm]a)\\s+(?:(?:late|ex|old|new|youngest|eldest|oldest|little|big|best|dear|close|former)\\s+)?(?:" + REL + "),?\\s+(?:named\\s+|called\\s+)?)" + NAME, "gu"), "heur"],
  ["PERSON", new RegExp("(?<=(?:[Cc]alls?|[Cc]alled)\\s+(?:me|him|her|them|us)\\s+|known as\\s+|nicknamed\\s+|\\baka\\s+|a\\.k\\.a\\.?\\s+|goes by\\s+|short for\\s+|\\bnamed\\s+)" + NAME1, "gu"), "heur"],
  ["ORG", new RegExp("(?<![\\p{L}\\p{N}])\\p{Lu}[\\p{L}'’&-]+\\s(?:" + ORG_SUF.split("|").sort((a, b) => b.length - a.length).join("|") + ")(?![\\p{L}\\p{N}])", "gu"), "heur"],
  ["ORG", /(?<![\p{L}])(?:[Cc]af[ée]|Restaurant|Hotel|[Hh][ôo]pital|[Hh][ôo]tel|Banco|Banque|Casa|Clinique)\s+(?:(?:de|du|of)\s+)?\p{Lu}[\p{L}'’-]+(?:\s\p{Lu}[\p{L}'’-]+)?/gu, "heur"],
  ["ORG", /\b(?:University|College|Institute) of \p{Lu}\p{L}+(?: \p{Lu}\p{L}+)?/gu, "heur"],
  ["ORG", wordRe(ORG_CI, "giu"), "heur"],
  ["ORG", wordRe(ORG_CS_USED, "gu"), "heur"],
  ["LOC", wordRe(LOC_GAZ, "gu"), "heur"],
];

export const NER_TYPE: Record<string, string> = { PER: "PERSON", LOC: "LOC", ORG: "ORG" };
export const LEAD = /^(?:Hi|Hello|Hey|Dear|Dr\.?|Mr\.?|Mrs\.?|Ms\.?|Mx\.?|Officer|Aunt|Auntie|Uncle|Grandma|Grandpa|Grandad|Nana|Nonna|Mama|Papa|Coach|Nurse|Principal|Prof\.?|Herr|Frau)\s+/;
export const WORDCH = /[\p{L}\p{N}]/u;
