// Cross-event "stage" hierarchies: the same team/person appears in events that are nested stages
// of one competition. Winning a later stage requires winning the earlier one.
//   NBA Champion ⇒ Conference Champion ⇒ ... ⇒ Makes Playoffs
//   US President 2028 ⇒ wins own party's nomination;  ⇒ own party wins the presidency
//   Wins election ⇒ is on the ballot
// Plus cross-event mutual exclusions for the same entity (Dem nominee vs Rep nominee, 1st vs 2nd place).
import { canonEntity, normText, maxYear } from '../text.js';

const LEAGUES = [
  ['wnba', /\bwnba\b/],
  ['nba', /\bnba\b/],
  ['nhl', /\bnhl\b|stanley cup/],
  ['mlb', /\bmlb\b|world series|\balcs\b|\bnlcs\b|american league|national league/],
  ['nfl', /\bnfl\b|pro football|super bowl|\bafc\b|\bnfc\b/],
];

const NOT_A_STAGE = /\b(mvp|award|rookie|coach|manager|player|scorer|draft|pick|win total|wins|points|seed|goals|yards|touchdowns|leader|record|relegat|top \d|finish|gold glove|cy young|heisman|free agency|next team|presidents'? trophy|group|qualif)/;

// Main path ranks (higher = later stage). Division titles only imply making the playoffs.
const STAGES = [
  ['division', /\b(afc|nfc|al|nl|american league|national league)\s+(north|south|east|west|central)\b|division (winner|champion)/],
  ['conf', /(eastern|western) conference champion\b|\b(afc|nfc) champion\b|(american|national) league champion|advance to (the )?finals\b/],
  ['semis', /advance to (the )?(alcs|nlcs|semifinals|semi-finals|conference finals|(afc|nfc) championship)/],
  ['round2', /advance to (the )?(second round|divisional round|quarterfinals)/],
  ['playoffs', /make (the )?(\w+ )?(playoffs|postseason)|team to make (the )?(playoffs|postseason)|make playoffs/],
  ['champ', /\bchampion\b|world series|\bwinner\b|stanley cup|super bowl|\bwin(s)? the\b/],
];
const RANK = { playoffs: 1, round2: 2, semis: 3, conf: 4, champ: 5 };

function sportsNode(ev, sample) {
  const t = normText(ev.title);
  const q = normText(sample.question);
  if (ev.isGame || NOT_A_STAGE.test(t)) return null;
  let stage = null;
  for (const [s, re] of STAGES) if (re.test(t)) { stage = s; break; }
  if (!stage) return null;
  const both = t + ' ' + q;
  let league = null;
  for (const [l, re] of LEAGUES) if (re.test(both)) { league = l; break; }
  if (!league) {
    // generic tournament: family = title with stage words and years removed
    const fam = t.replace(/\b(20\d\d(-\d\d)?|team(s)? to|who will|which teams? will|winner|champion(ship)?|make (the )?(playoffs|postseason)|advance to( the)?|playoffs?|the|:|\?)\b/g, ' ')
      .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (fam.length < 4) return null;
    league = 'generic:' + fam;
  }
  if (league === 'nba' && stage === 'division') return null; // NBA division winners aren't guaranteed a playoff spot
  return { kind: 'sports', family: league, stage, season: maxYear(q) ?? maxYear(t) };
}

function politicsNode(ev, sample) {
  const t = normText(ev.title);
  const q = normText(sample.question);
  let m;
  if ((m = t.match(/^(democratic|republican) presidential nominee (20\d\d)/)))
    return { kind: 'uspres', stage: 'nominee', party: m[1], season: +m[2], family: 'uspres' };
  if ((m = t.match(/^presidential election winner (20\d\d)/)))
    return { kind: 'uspres', stage: 'win', season: +m[1], family: 'uspres' };
  if ((m = t.match(/which party wins (20\d\d) us presidential election/)))
    return { kind: 'uspres', stage: 'party', season: +m[1], family: 'uspres' };
  if (/presidential election/.test(t) && !/vote share|margin|turnout|round:|place|state|1st|2nd|3rd|debate|announce/.test(t)) {
    const fam = t.replace(/\b(20\d\d|next|presidential election|winner|who will be on the ballot|who will advance to the 2nd round|:|\?)/g, ' ')
      .replace(/'s\b/g, '').replace(/[^a-z ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!fam) return null;
    let stage = 'win';
    if (/on the ballot/.test(t)) stage = 'ballot';
    else if (/advance|2nd round|second round|runoff/.test(t)) stage = 'round2';
    return { kind: 'pres', family: 'pres:' + fam, stage, season: maxYear(q) ?? maxYear(t) };
  }
  return null;
}

function placeNode(ev, sample) {
  const t = normText(ev.title);
  const m = t.match(/\b(1st|2nd|3rd|4th|first|second|third) place\b/);
  if (!m || ev.isGame) return null;
  return { kind: 'place', family: 'place:' + t.replace(m[0], '#'), place: m[1], season: maxYear(sample.question) };
}

function entityOf(m) {
  if (m.label) return canonEntity(m.label);
  const mm = normText(m.question).match(/^will (?:the )?(.+?) (?:win|be|make|advance|qualify|finish|control)\b/);
  return mm ? canonEntity(mm[1]) : null;
}

export const hierarchyDetector = {
  id: 'hierarchy',
  name: 'Stage hierarchy & cross-event exclusions',
  detect(ctx) {
    const nodes = [];
    for (const ev of ctx.events) {
      const ms = ev.marketIds.map((id) => ctx.byId.get(id)).filter((m) => m && m.isYesNo);
      if (!ms.length) continue;
      const node = politicsNode(ev, ms[0]) || sportsNode(ev, ms[0]) || placeNode(ev, ms[0]);
      if (!node) continue;
      const ents = new Map();
      for (const m of ms) {
        const e = entityOf(m);
        if (!e || /^(other|another|person [a-z]+|none|no one|field)$/.test(e)) continue;
        if (ents.has(e)) ents.set(e, null); else ents.set(e, m); // duplicates -> ambiguous
      }
      nodes.push({ ev, node, ents });
    }

    const rels = [];
    const seen = new Set();
    const add = (r) => {
      const k = r.type + '|' + [r.a, r.b].sort().join('|');
      if (seen.has(k)) return;
      seen.add(k); rels.push(r);
    };
    const sameSeason = (x, y) => {
      if (x.node.season == null || y.node.season == null || x.node.season === y.node.season) return true;
      // seasons straddle years ("2026 NFC North" vs "2027 NFL Playoffs"): accept ±1 if both resolve close together
      const dt = Math.abs(Date.parse(x.ev.endDate) - Date.parse(y.ev.endDate));
      return Math.abs(x.node.season - y.node.season) === 1 && dt < 75 * 864e5;
    };

    // Find the unique node of a given stage that contains entity e.
    const lookup = (family, stage, e, season, filter) => {
      const hits = nodes.filter((n) => n.node.family === family && n.node.stage === stage && n.ents.get(e) &&
        (season == null || n.node.season == null || n.node.season === season) && (!filter || filter(n)));
      return hits.length === 1 ? hits[0] : null;
    };

    for (const hi of nodes) {
      const { node } = hi;
      // --- sports ladders
      if (node.kind === 'sports') {
        for (const lo of nodes) {
          if (lo === hi || lo.node.kind !== 'sports' || lo.node.family !== node.family || !sameSeason(hi, lo)) continue;
          const implies = (RANK[node.stage] && RANK[lo.node.stage] && RANK[node.stage] > RANK[lo.node.stage]) ||
            (node.stage === 'division' && lo.node.stage === 'playoffs');
          if (!implies) continue;
          for (const [e, mHi] of hi.ents) {
            const mLo = lo.ents.get(e);
            if (!mHi || !mLo) continue;
            // a team must sit in exactly one event of the lower stage (e.g. only one conference)
            if (lookup(node.family, lo.node.stage, e, lo.node.season) !== lo) continue;
            add({ type: 'implication', a: mHi.id, b: mLo.id, confidence: 0.95, detector: 'hierarchy', subtype: 'stage',
              rationale: `${mHi.label || e} can only reach "${hi.ev.title}" by first achieving "${lo.ev.title}". The later stage is a strict subset of the earlier one.` });
          }
        }
      }
      // --- US presidency
      if (node.kind === 'uspres' && node.stage === 'win') {
        for (const [e, mWin] of hi.ents) {
          if (!mWin) continue;
          const noms = nodes.filter((n) => n.node.kind === 'uspres' && n.node.stage === 'nominee' && n.node.season === node.season && n.ents.get(e));
          if (noms.length !== 1) continue; // unknown party or listed in both primaries -> skip
          const nom = noms[0];
          add({ type: 'implication', a: mWin.id, b: nom.ents.get(e).id, confidence: 0.88, detector: 'hierarchy', subtype: 'nomination',
            rationale: `To win the ${node.season} presidency, ${mWin.label} would in practice need to win the ${nom.node.party} nomination first (an independent run is the only, very unlikely, exception).` });
          const party = nodes.find((n) => n.node.kind === 'uspres' && n.node.stage === 'party' && n.node.season === node.season);
          const pm = party && [...party.ents.entries()].find(([k, v]) => v && k.startsWith(nom.node.party.slice(0, 8)))?.[1];
          if (pm) add({ type: 'implication', a: mWin.id, b: pm.id, confidence: 0.86, detector: 'hierarchy', subtype: 'party',
            rationale: `${mWin.label} is listed in the ${nom.node.party} primary, so ${mWin.label} winning implies the ${nom.node.party} party wins the ${node.season} presidency.` });
        }
      }
      if (node.kind === 'uspres' && node.stage === 'nominee') {
        for (const other of nodes) {
          if (other.node.kind !== 'uspres' || other.node.stage !== 'nominee' || other.node.party === node.party || other.node.season !== node.season) continue;
          for (const [e, m1] of hi.ents) {
            const m2 = other.ents.get(e);
            if (!m1 || !m2) continue;
            add({ type: 'exclusive', a: m1.id, b: m2.id, confidence: 0.97, detector: 'hierarchy', subtype: 'nominee',
              rationale: `${m1.label} cannot be both the Democratic and the Republican nominee in ${node.season}.` });
          }
        }
      }
      // --- generic elections: winning implies being on the ballot; advancing implies being on the ballot
      if (node.kind === 'pres' && (node.stage === 'win' || node.stage === 'round2')) {
        for (const lo of nodes) {
          if (lo.node.kind !== 'pres' || lo.node.family !== node.family || lo.node.stage !== 'ballot' || !sameSeason(hi, lo)) continue;
          for (const [e, m1] of hi.ents) {
            const m2 = lo.ents.get(e);
            if (!m1 || !m2) continue;
            add({ type: 'implication', a: m1.id, b: m2.id, confidence: 0.95, detector: 'hierarchy', subtype: 'ballot',
              rationale: `A candidate cannot ${node.stage === 'win' ? 'win the election' : 'advance to the second round'} without being on the ballot.` });
          }
        }
      }
      // --- finishing places are mutually exclusive for the same entity
      if (node.kind === 'place') {
        for (const other of nodes) {
          if (other === hi || other.node.kind !== 'place' || other.node.family !== node.family || other.node.place === node.place) continue;
          for (const [e, m1] of hi.ents) {
            const m2 = other.ents.get(e);
            if (!m1 || !m2) continue;
            add({ type: 'exclusive', a: m1.id, b: m2.id, confidence: 0.97, detector: 'hierarchy', subtype: 'place',
              rationale: `${m1.label} cannot finish both ${node.place} and ${other.node.place}.` });
          }
        }
      }
    }
    return rels;
  },
};
