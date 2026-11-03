const test = require('node:test');
const assert = require('node:assert/strict');
const { interpretDhaSearch, phaseSearchKeeps, parseScrapedMessageId } = require('../smartLocationSearch');
const { collectPhaseAreaNames, isPhaseAreaLabel, phasePlaceCandidates, labelsFromConfirmed, areaSpellingTerms, choosePlacesArea } = require('../ai/googlePhaseMap');

test('bare dha is every DHA listing, not a phase', () => {
  assert.equal(interpretDhaSearch('dha').kind, 'dha-all');
  assert.equal(interpretDhaSearch('Defence').kind, 'dha-all');
  assert.equal(interpretDhaSearch('dha karachi').kind, 'dha-all');
});

test('dha phase 6 stays phase 6 and is not split', () => {
  const six = interpretDhaSearch('dha phase 6');
  assert.equal(six.kind, 'phase');
  assert.equal(six.phaseNumber, 6);
  const five = interpretDhaSearch('DHA Phase 5');
  assert.equal(five.kind, 'phase');
  assert.equal(five.phaseNumber, 5);
  assert.equal(interpretDhaSearch('phase vi').phaseNumber, 6);
  assert.equal(interpretDhaSearch('phase 6 bukhari').kind, 'phase');
});

test('dha plus an area searches that area only', () => {
  const bukhari = interpretDhaSearch('dha bukhari');
  assert.equal(bukhari.kind, 'area');
  assert.equal(bukhari.area, 'bukhari');
  const rahat = interpretDhaSearch('defence rahat commercial');
  assert.equal(rahat.kind, 'area');
  assert.equal(rahat.area, 'rahat commercial');
});

test('dha city stays one place name', () => {
  const city = interpretDhaSearch('dha city');
  assert.equal(city.kind, 'phrase');
  assert.equal(city.area, 'dha city');
  assert.equal(interpretDhaSearch('dck').kind, 'phrase');
  assert.equal(interpretDhaSearch('dck').area, 'dha city');
});

test('defence view and clifton are not DHA phase searches', () => {
  assert.equal(interpretDhaSearch('defence view').kind, 'other');
  assert.equal(interpretDhaSearch('Clifton Block 5').kind, 'other');
  assert.equal(interpretDhaSearch('sector 5').kind, 'other');
});

test('phase 5 to 7 cards stay in each of those phase searches', () => {
  const row = { phase: 5, phase_max: 7, area: 'DHA', vicinity: 'Phase 5 to 7' };
  assert.equal(phaseSearchKeeps(row, 5, []), true);
  assert.equal(phaseSearchKeeps(row, 6, []), true);
  assert.equal(phaseSearchKeeps(row, 7, []), true);
  assert.equal(phaseSearchKeeps(row, 8, []), false);
});

test('clifton and defence view stay out of a DHA phase search', () => {
  assert.equal(phaseSearchKeeps({ area: 'Clifton', vicinity: 'Block 5', phase: null }, 5, []), false);
  assert.equal(phaseSearchKeeps({ area: 'Defence View', vicinity: 'Phase 2', phase: 2 }, 2, []), false);
});

test('phase area labels drop scraps and keep Phase 6 places', () => {
  assert.equal(isPhaseAreaLabel('off Faisal'), false);
  assert.equal(isPhaseAreaLabel('phase vi'), false);
  assert.equal(isPhaseAreaLabel('D.H.A Phase 6'), false);
  assert.equal(isPhaseAreaLabel('Rahat Commercial'), true);
  const phase5 = phasePlaceCandidates(5);
  assert.ok(phase5.some((name) => /saba commercial/i.test(name)));
  const phase2 = phasePlaceCandidates(2);
  assert.ok(phase2.some((name) => /a market/i.test(name)));
  const candidates = phasePlaceCandidates(6);
  assert.ok(candidates.some((name) => /bukhari commercial/i.test(name)));
  assert.ok(candidates.some((name) => /ittehad/i.test(name)));
  assert.equal(candidates.some((name) => /^phase 6$/i.test(name)), false);
  const labels = labelsFromConfirmed(['rahat', 'Rahat Commercial', 'khayaban-e-bukhari', 'bukhari']);
  assert.ok(labels.includes('Rahat Commercial'));
  assert.ok(labels.some((name) => /bukhari/i.test(name)));
});

test('defence area spellings collapse seher sehar and sahar', () => {
  const terms = areaSpellingTerms('Sehar Commercial Area', 'seher commercial');
  assert.ok(terms.includes('sehar commercial'));
  assert.ok(terms.includes('seher commercial'));
  assert.ok(terms.includes('sahar commercial'));
  const fromSahar = areaSpellingTerms('Sahar commercial', 'sahar commercial');
  assert.ok(fromSahar.includes('seher commercial'));
  assert.ok(fromSahar.includes('sehar commercial'));
  assert.equal(terms.includes('commercial'), false);
});

test('seher commercial prefers Seher Commercial Area over a Bukhari pin', () => {
  const chosen = choosePlacesArea([
    {
      name: 'sehar commercial',
      formatted_address: 'sehar commercial, D.H.A Phase 6 Bukhari Commercial Area Phase 6 Defence Housing Authority, Karachi, 75500'
    },
    {
      name: 'Seher Commercial Area',
      formatted_address: 'D.H.A. Phase 7 Seher Commercial Area Phase 7 Defence Housing Authority, Karachi, 75500'
    }
  ], 'seher commercial');
  assert.equal(chosen.name, 'Seher Commercial Area');
  const sahar = choosePlacesArea([
    {
      name: 'Sahar commercial',
      formatted_address: 'Sahar commercial, Plot 18 Ln 4, Defence Phase 7 Seher Commercial Area Phase 7 Defence Housing Authority, Karachi, 75500'
    }
  ], 'sahar commercial');
  assert.equal(sahar.name, 'Seher Commercial Area');
});

test('phase 5 search drops a card whose place line says phase 8', () => {
  const phase8 = {
    phase: 5,
    area: 'Al-Murtaza Commercial',
    vicinity: 'Phase 8',
    summary: 'DHA Phase 5 Badar Commercial'
  };
  assert.equal(phaseSearchKeeps(phase8, 5, ['Badar Commercial', 'Hilal']), false);
  const writtenOnly = {
    phase: null,
    area: 'Al-Murtaza Commercial',
    vicinity: 'Phase 8',
    summary: 'phase 5'
  };
  assert.equal(phaseSearchKeeps(writtenOnly, 5, ['Badar Commercial']), false);
  const phase5 = {
    phase: null,
    area: 'Badar Commercial',
    vicinity: 'Phase 5'
  };
  assert.equal(phaseSearchKeeps(phase5, 5, ['Badar Commercial']), true);
  const areaOnly = {
    phase: null,
    area: 'Badar Commercial',
    vicinity: ''
  };
  assert.equal(phaseSearchKeeps(areaOnly, 5, ['Badar Commercial']), true);
});

test('Google phase areas keep commercials in that phase', () => {
  const names = collectPhaseAreaNames([
    {
      name: 'Bukhari Commercial Area',
      formatted_address: 'Bukhari Commercial Area, DHA Phase 6, Karachi, Pakistan',
      types: ['neighborhood', 'political']
    },
    {
      name: 'Pizza Hut',
      formatted_address: 'Bukhari Commercial, DHA Phase 6, Karachi',
      types: ['restaurant', 'food']
    },
    {
      name: 'Nishat Commercial',
      formatted_address: 'Nishat Commercial, DHA Phase 5, Karachi',
      types: ['neighborhood']
    },
    {
      name: 'DHA Phase 6',
      formatted_address: 'DHA Phase 6, Karachi, Pakistan',
      types: ['sublocality', 'political']
    }
  ], 6);
  assert.ok(names.includes('Bukhari Commercial Area'));
  assert.equal(names.includes('Pizza Hut'), false);
  assert.equal(names.includes('Nishat Commercial'), false);
  assert.equal(names.includes('DHA Phase 6'), false);
});

test('scraped message id search accepts id, hash, and bare digits', () => {
  assert.equal(parseScrapedMessageId('12377'), 12377);
  assert.equal(parseScrapedMessageId('#12377'), 12377);
  assert.equal(parseScrapedMessageId('id:12377'), 12377);
  assert.equal(parseScrapedMessageId('id 12377'), 12377);
  assert.equal(parseScrapedMessageId('phase 8'), null);
  assert.equal(interpretDhaSearch('12377').kind, 'message-id');
  assert.equal(interpretDhaSearch('12377').messageId, 12377);
});
