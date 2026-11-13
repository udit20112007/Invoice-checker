// HSN/SAC help: what chapter a code belongs to, whether the item description fits it, purchases whose
// credit is blocked by Section 17(5), and services where the buyer pays the tax (reverse charge).
// The lists are short and cautious on purpose: they raise a question, a person decides.
import type { Item } from "./types.ts";

const CHAPTERS: Record<string, string> = {
  "01": "Live animals", "02": "Meat", "03": "Fish", "04": "Dairy, eggs, honey", "05": "Other animal products", "06": "Live plants", "07": "Vegetables", "08": "Fruit and nuts",
  "09": "Coffee, tea, spices", "10": "Cereals", "11": "Flour and milled products", "12": "Oil seeds", "13": "Gums and resins", "14": "Vegetable plaiting materials",
  "15": "Fats and oils", "16": "Prepared meat or fish", "17": "Sugar", "18": "Cocoa", "19": "Bakery and cereal preparations", "20": "Prepared vegetables and fruit",
  "21": "Miscellaneous food preparations", "22": "Beverages", "23": "Animal feed", "24": "Tobacco", "25": "Salt, stone, cement", "26": "Ores", "27": "Fuels and oils",
  "28": "Inorganic chemicals", "29": "Organic chemicals", "30": "Medicines", "31": "Fertilisers", "32": "Paints, dyes, inks", "33": "Perfumery and cosmetics",
  "34": "Soap and detergents", "35": "Glues and starches", "36": "Explosives and matches", "37": "Photographic goods", "38": "Miscellaneous chemicals", "39": "Plastics",
  "40": "Rubber", "41": "Hides and leather", "42": "Leather goods and bags", "43": "Fur", "44": "Wood", "45": "Cork", "46": "Straw and basketware", "47": "Paper pulp",
  "48": "Paper and paperboard", "49": "Printed books and newspapers", "50": "Silk", "51": "Wool", "52": "Cotton", "53": "Other vegetable fibres", "54": "Man-made filaments",
  "55": "Man-made staple fibres", "56": "Wadding, felt, rope", "57": "Carpets", "58": "Special woven fabrics", "59": "Coated fabrics", "60": "Knitted fabrics",
  "61": "Knitted clothing", "62": "Woven clothing", "63": "Other made-up textiles", "64": "Footwear", "65": "Headgear", "66": "Umbrellas", "67": "Feathers and artificial flowers",
  "68": "Stone, plaster, cement articles", "69": "Ceramics", "70": "Glass", "71": "Jewellery and precious metals", "72": "Iron and steel", "73": "Iron and steel articles",
  "74": "Copper", "75": "Nickel", "76": "Aluminium", "78": "Lead", "79": "Zinc", "80": "Tin", "81": "Other base metals", "82": "Tools and cutlery", "83": "Miscellaneous metal articles",
  "84": "Machinery and mechanical appliances", "85": "Electrical machinery and equipment", "86": "Railway stock", "87": "Vehicles", "88": "Aircraft", "89": "Ships and boats",
  "90": "Optical, measuring and medical instruments", "91": "Clocks and watches", "92": "Musical instruments", "93": "Arms and ammunition", "94": "Furniture, bedding, lamps and light fittings",
  "95": "Toys and sports goods", "96": "Miscellaneous manufactured articles", "97": "Works of art", "98": "Project imports and special items", "99": "Services",
};
export const chapterOf = (hsn: string) => (/^\d{4,8}$/.test(hsn) ? CHAPTERS[hsn.slice(0, 2)] ?? null : null);
export const hsnValid = (hsn: string) => /^\d{4}(\d{2}){0,2}$/.test(hsn) && !!CHAPTERS[hsn.slice(0, 2)];

// words that point clearly to a few chapters; parts and accessories are left alone
const HINTS: [RegExp, string[]][] = [
  [/\b(cable|wire)s?\b/i, ["85", "74", "72", "73", "76"]],
  [/\b(mcb|switchgear|distribution board|fuse|relay)s?\b/i, ["85"]],
  [/\b(fan|pump|compressor)s?\b/i, ["84"]],
  [/\b(screw|bolt|nut|washer|rivet)s?\b/i, ["73", "74", "76"]],
  [/\bcement\b/i, ["25"]], [/\b(paint|varnish)\b/i, ["32"]],
  [/\b(laptop|computer|printer)s?\b/i, ["84"]], [/\b(rice|wheat|atta)\b/i, ["10", "11"]], [/\btyres?\b/i, ["40"]],
  [/\b(freight|transport|courier|catering|consultancy|audit fees|legal fees|rent)\b/i, ["99"]],
];
const ACCESSORY = /\b(plate|cover|box|holder|stand|case|part|spare|kit|tray|tie|clip|lug|gland|tape|sleeve|blade|guard|regulator|duct|cutter|stripper)s?\b/i;

/** A question to raise when the description and the HSN chapter don't seem to fit, else null. */
export function hsnMismatch(it: Item): string | null {
  if (!hsnValid(it.hsn) || ACCESSORY.test(it.description)) return null;
  const ch = it.hsn.slice(0, 2);
  for (const [re, ok] of HINTS) {
    const m = it.description.match(re);
    if (m && !ok.includes(ch)) return `“${it.description}” is billed under HSN ${it.hsn}, which is ${CHAPTERS[ch]} (chapter ${ch}); ${m[0].toLowerCase()} is usually under chapter ${ok.join(" or ")}.`;
  }
  return null;
}

// Section 17(5), CGST Act: credit that can't be claimed even on a correct invoice
const BLOCKED: [RegExp, string][] = [
  [/\b(catering|caterers?|food|lunch|dinner|meals?|snacks|beverages?|restaurant|canteen)\b/i, "food, beverages and outdoor catering"],
  [/\b(health|life|medical)\s*insurance|mediclaim\b/i, "health and life insurance"],
  [/\b(club|gym|fitness|health\s*club)\b.*\b(membership|fees?|subscription)\b|\bmembership\b.*\b(club|gym)\b/i, "club, health and fitness centre membership"],
  [/\b(beauty|salon|spa|cosmetic surgery|plastic surgery)\b/i, "beauty treatment and cosmetic surgery"],
  [/\b(rent[\s-]*a[\s-]*cab|cab hire|taxi hire|car rental)\b/i, "hiring of passenger vehicles"],
  [/\b(holiday|leave travel|ltc|vacation)\b/i, "travel benefits to employees"],
  [/\bgifts?\b|\bfree samples?\b/i, "gifts and free samples"],
  [/\b(works contract|civil work|construction of|building construction)\b/i, "works contract and construction of immovable property"],
];
export function blockedCredit(items: Item[]): string | null {
  for (const it of items) {
    if (/^8703/.test(it.hsn)) return "motor vehicles for carrying up to 13 people";
    for (const [re, what] of BLOCKED) if (re.test(it.description)) return what;
  }
  return null;
}

// Services where the registered buyer usually pays the tax under reverse charge (Section 9(3) notifications)
export function reverseChargeLikely(items: Item[]): string | null {
  for (const it of items) {
    if (/^9965|^9967/.test(it.hsn) && /\b(freight|transport|lorry|cartage|gta|goods carriage)\b/i.test(it.description)) return "transport of goods by road (goods transport agency)";
    if (/\b(freight|lorry hire|cartage)\b/i.test(it.description) && !it.hsn) return "transport of goods by road (goods transport agency)";
    if (/\b(advocate|legal (fees|services|charges))\b/i.test(it.description)) return "legal services from an advocate";
    if (/\bsecurity (guard|services)\b/i.test(it.description)) return "security services";
  }
  return null;
}
