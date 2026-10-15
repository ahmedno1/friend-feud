import {
  GameEvent,
  GameState,
  MatchOutcome,
  MatchStatus,
  RoundAnswer,
  RoundNumber,
  RoundPhase,
  RoundState,
  ScoreAward,
  Team,
} from './types';

export const GAME_STATE_SCHEMA_VERSION = 1 as const;

interface GameStateEnvelope {
  readonly stateSchemaVersion: number;
  readonly state: PersistedGameState;
}

type PersistedRoundState = Omit<RoundState, 'questionPoints'>;
type PersistedGameState = Omit<GameState, 'teamScores' | 'rounds'> & {
  readonly rounds: readonly [PersistedRoundState, PersistedRoundState, PersistedRoundState];
};

const TEAM_VALUES: readonly Team[] = ['team_one', 'team_two'];
const MATCH_STATUSES: readonly MatchStatus[] = [
  'setup',
  'in_progress',
  'paused_host_disconnected',
  'completed',
];
const ROUND_PHASES: readonly RoundPhase[] = [
  'pending',
  'toss',
  'ownership',
  'main_play',
  'steal',
  'completed',
];
const OUTCOMES: readonly MatchOutcome[] = ['team_one', 'team_two', 'tie', null];
const EVENT_TYPES: readonly GameEvent['type'][] = [
  'match_started',
  'buzz_accepted',
  'ownership_answered',
  'ownership_turn_transferred',
  'ownership_answer_retracted',
  'ownership_error_recorded',
  'ownership_retry_granted',
  'answer_revealed',
  'answer_retracted',
  'play_attempt_granted',
  'play_error_recorded',
  'steal_opened',
  'steal_resolved',
  'round_completed',
  'round_advanced',
  'match_paused',
  'match_resumed',
  'match_completed',
];
const AWARD_REASONS: readonly ScoreAward['reason'][] = [
  'all_answers_revealed',
  'steal_success',
  'steal_failed',
];
const UNDEFINED_MARKER = '$friend-feud:undefined:v1';

export class GameStateSerializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GameStateSerializationError';
  }
}

export function serializeGameState(state: GameState): string {
  validateGameState(state);
  const persistedState: PersistedGameState = {
    id: state.id,
    status: state.status,
    rounds: state.rounds.map(({ questionPoints: _questionPoints, ...round }) => round) as [
      PersistedRoundState,
      PersistedRoundState,
      PersistedRoundState,
    ],
    currentRoundNumber: state.currentRoundNumber,
    outcome: state.outcome,
    revision: state.revision,
    nextEventSequence: state.nextEventSequence,
    events: state.events,
  };
  const envelope: GameStateEnvelope = {
    stateSchemaVersion: GAME_STATE_SCHEMA_VERSION,
    state: persistedState,
  };

  try {
    const serialized = JSON.stringify(envelope, (_key, value: unknown) => (
      value === undefined ? { [UNDEFINED_MARKER]: true } : value
    ));
    if (serialized === undefined) throw new GameStateSerializationError('The game state could not be serialized.');
    return serialized;
  } catch (error) {
    if (error instanceof GameStateSerializationError) throw error;
    throw new GameStateSerializationError(`The game state could not be serialized: ${errorMessage(error)}`);
  }
}

export function hydrateGameState(serialized: string): GameState {
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized) as unknown;
  } catch (error) {
    throw new GameStateSerializationError(`The serialized game state is not valid JSON: ${errorMessage(error)}`);
  }

  const decoded = decodeUndefinedMarkers(parsed, '$');
  assertShape(decoded, '$', ['stateSchemaVersion', 'state']);
  const envelope = decoded as Record<string, unknown>;
  if (!isSafeInteger(envelope.stateSchemaVersion) || envelope.stateSchemaVersion !== GAME_STATE_SCHEMA_VERSION) {
    throw new GameStateSerializationError(
      `Unsupported game state schema version: ${String(envelope.stateSchemaVersion)}.`,
    );
  }

  const state = hydratePersistedState(envelope.state);
  validateGameState(state);
  return state;
}

function hydratePersistedState(value: unknown): GameState {
  assertShape(value, '$.state', [
    'id',
    'status',
    'rounds',
    'currentRoundNumber',
    'outcome',
    'revision',
    'nextEventSequence',
    'events',
  ]);
  const persisted = value as Record<string, unknown>;
  if (!Array.isArray(persisted.rounds) || persisted.rounds.length !== 3) {
    fail('$.state.rounds', 'must contain exactly three rounds');
  }
  const rounds = persisted.rounds.map((round, index) => hydratePersistedRound(round, index + 1 as RoundNumber)) as [
    RoundState,
    RoundState,
    RoundState,
  ];
  const teamScores: Record<Team, number> = { team_one: 0, team_two: 0 };
  for (let index = 0; index < rounds.length; index += 1) {
    const award = rounds[index].scoreAward;
    if (award === null) continue;
    validateScoreAward(award, `$.state.rounds[${index}].scoreAward`);
    const next = safeAdd(teamScores[award.team], award.points);
    if (next === null) fail('$.state.teamScores', 'round awards exceed the safe integer range');
    teamScores[award.team] = next;
  }
  return { ...persisted, rounds, teamScores } as unknown as GameState;
}

function hydratePersistedRound(value: unknown, number: RoundNumber): RoundState {
  const path = `$.state.rounds[${number - 1}]`;
  assertShape(value, path, [
    'number',
    'phase',
    'questionId',
    'questionText',
    'answers',
    'firstBuzzTeam',
    'ownershipTurnTeam',
    'ownerTeam',
    'answeringTeam',
    'ownershipMisses',
    'pendingOwnershipDecisionTeam',
    'ownershipResolution',
    'mainPlayErrors',
    'pendingRetractedAnswerTeam',
    'steal',
    'revealSequence',
    'scoreAward',
  ]);
  const round = value as Record<string, unknown>;
  if (!Array.isArray(round.answers)) fail(`${path}.answers`, 'must be an array');
  const answerPoints: number[] = [];
  round.answers.forEach((answer, index) => {
    const answerPath = `${path}.answers[${index}]`;
    assertShape(answer, answerPath, ['id', 'text', 'points', 'revealed', 'activeRevealId', 'revealedByTeam']);
    const answerRecord = answer as Record<string, unknown>;
    assertNonNegativeSafeInteger(answerRecord.points, `${answerPath}.points`);
    assertBoolean(answerRecord.revealed, `${answerPath}.revealed`);
    if (answerRecord.revealed) answerPoints.push(answerRecord.points as number);
  });
  return { ...round, questionPoints: sumSafe(answerPoints, `${path}.answers`) } as unknown as RoundState;
}

function decodeUndefinedMarkers(value: unknown, path: string): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => decodeUndefinedMarkers(item, `${path}[${index}]`));
  }
  if (!isRecord(value)) return value;

  const keys = Object.keys(value);
  if (keys.length === 1 && value[UNDEFINED_MARKER] === true) return undefined;

  const decoded: Record<string, unknown> = {};
  for (const key of keys) decoded[key] = decodeUndefinedMarkers(value[key], `${path}.${key}`);
  return decoded;
}

function validateGameState(value: unknown): asserts value is GameState {
  assertShape(value, '$.state', [
    'id',
    'status',
    'rounds',
    'currentRoundNumber',
    'teamScores',
    'outcome',
    'revision',
    'nextEventSequence',
    'events',
  ]);
  const state = value as Record<string, unknown>;
  assertNonEmptyString(state.id, '$.state.id');
  assertEnum(state.status, MATCH_STATUSES, '$.state.status');
  assertRoundNumberOrNull(state.currentRoundNumber, '$.state.currentRoundNumber');
  assertEnum(state.outcome, OUTCOMES, '$.state.outcome');
  assertNonNegativeSafeInteger(state.revision, '$.state.revision');
  assertPositiveSafeInteger(state.nextEventSequence, '$.state.nextEventSequence');
  validateTeamScores(state.teamScores, '$.state.teamScores');

  if (!Array.isArray(state.rounds) || state.rounds.length !== 3) {
    fail('$.state.rounds', 'must contain exactly three rounds');
  }
  const rounds = state.rounds as unknown[];
  rounds.forEach((round, index) => validateRound(round, index + 1 as RoundNumber, `$.state.rounds[${index}]`));

  if (!Array.isArray(state.events)) fail('$.state.events', 'must be an array');
  const events = state.events as unknown[];
  events.forEach((event, index) => validateEvent(event, index + 1, `$.state.events[${index}]`));
  if (state.nextEventSequence !== events.length + 1) {
    fail('$.state.nextEventSequence', 'must equal the next contiguous event sequence');
  }
  if ((state.revision as number) > events.length) {
    fail('$.state.revision', 'cannot exceed the number of accepted-command events');
  }

  rounds.forEach((round, index) => {
    validateRoundEvents(round as RoundState, index + 1 as RoundNumber, events as GameEvent[]);
  });
  validateMatchProgression(state as unknown as GameState);
  validateTeamScoreTotals(state as unknown as GameState);
}

function validateTeamScores(value: unknown, path: string): void {
  assertShape(value, path, ['team_one', 'team_two']);
  const scores = value as Record<string, unknown>;
  assertNonNegativeSafeInteger(scores.team_one, `${path}.team_one`);
  assertNonNegativeSafeInteger(scores.team_two, `${path}.team_two`);
}

function validateRound(value: unknown, expectedNumber: RoundNumber, path: string): void {
  assertShape(value, path, [
    'number',
    'phase',
    'questionId',
    'questionText',
    'answers',
    'firstBuzzTeam',
    'ownershipTurnTeam',
    'ownerTeam',
    'answeringTeam',
    'ownershipMisses',
    'pendingOwnershipDecisionTeam',
    'ownershipResolution',
    'mainPlayErrors',
    'pendingRetractedAnswerTeam',
    'steal',
    'questionPoints',
    'revealSequence',
    'scoreAward',
  ]);
  const round = value as Record<string, unknown>;
  if (round.number !== expectedNumber) fail(`${path}.number`, `must be ${expectedNumber}`);
  assertEnum(round.phase, ROUND_PHASES, `${path}.phase`);
  assertNonEmptyString(round.questionId, `${path}.questionId`);
  assertNonEmptyString(round.questionText, `${path}.questionText`);
  assertTeamOrNull(round.firstBuzzTeam, `${path}.firstBuzzTeam`);
  assertTeamOrNull(round.ownershipTurnTeam, `${path}.ownershipTurnTeam`);
  assertTeamOrNull(round.ownerTeam, `${path}.ownerTeam`);
  assertTeamOrNull(round.answeringTeam, `${path}.answeringTeam`);
  assertNonNegativeSafeInteger(round.ownershipMisses, `${path}.ownershipMisses`);
  assertTeamOrNull(round.pendingOwnershipDecisionTeam, `${path}.pendingOwnershipDecisionTeam`);
  assertNonNegativeSafeInteger(round.mainPlayErrors, `${path}.mainPlayErrors`);
  if ((round.mainPlayErrors as number) > 3) fail(`${path}.mainPlayErrors`, 'cannot exceed three');
  assertTeamOrNull(round.pendingRetractedAnswerTeam, `${path}.pendingRetractedAnswerTeam`);
  assertNonNegativeSafeInteger(round.questionPoints, `${path}.questionPoints`);
  assertNonNegativeSafeInteger(round.revealSequence, `${path}.revealSequence`);
  validateOwnershipResolution(round.ownershipResolution, `${path}.ownershipResolution`);
  validateSteal(round.steal, `${path}.steal`);
  validateScoreAward(round.scoreAward, `${path}.scoreAward`);

  if (!Array.isArray(round.answers) || round.answers.length === 0) {
    fail(`${path}.answers`, 'must contain at least one answer');
  }
  const answers = round.answers as unknown[];
  answers.forEach((answer, index) => validateAnswer(answer, `${path}.answers[${index}]`));
  if (new Set(answers.map((answer) => (answer as RoundAnswer).id)).size !== answers.length) {
    fail(`${path}.answers`, 'answer ids must be unique within a round');
  }

  const questionTotal = sumSafe(answers.map((answer) => (answer as RoundAnswer).points), `${path}.answers`);
  const revealedTotal = sumSafe(
    answers.filter((answer) => (answer as RoundAnswer).revealed).map((answer) => (answer as RoundAnswer).points),
    `${path}.answers`,
  );
  if ((round.questionPoints as number) !== revealedTotal) {
    fail(`${path}.questionPoints`, 'must equal the points of currently revealed answers');
  }
  validateRoundPhase(round as unknown as RoundState, questionTotal, path);
}

function validateAnswer(value: unknown, path: string): void {
  assertShape(value, path, ['id', 'text', 'points', 'revealed', 'activeRevealId', 'revealedByTeam']);
  const answer = value as Record<string, unknown>;
  assertNonEmptyString(answer.id, `${path}.id`);
  assertNonEmptyString(answer.text, `${path}.text`);
  assertNonNegativeSafeInteger(answer.points, `${path}.points`);
  assertBoolean(answer.revealed, `${path}.revealed`);
  if (answer.activeRevealId !== null) assertPositiveSafeInteger(answer.activeRevealId, `${path}.activeRevealId`);
  assertTeamOrNull(answer.revealedByTeam, `${path}.revealedByTeam`);
  const hasActiveReveal = answer.activeRevealId !== null && answer.revealedByTeam !== null;
  if (answer.revealed !== hasActiveReveal) {
    fail(path, 'revealed must agree with activeRevealId and revealedByTeam');
  }
}

function validateOwnershipResolution(value: unknown, path: string): void {
  if (value === null) return;
  assertShape(value, path, ['id', 'team', 'retracted']);
  const resolution = value as Record<string, unknown>;
  assertPositiveSafeInteger(resolution.id, `${path}.id`);
  assertTeam(resolution.team, `${path}.team`);
  assertBoolean(resolution.retracted, `${path}.retracted`);
}

function validateSteal(value: unknown, path: string): void {
  assertShape(value, path, ['status', 'team', 'result']);
  const steal = value as Record<string, unknown>;
  assertEnum(steal.status, ['unavailable', 'available', 'used'] as const, `${path}.status`);
  assertTeamOrNull(steal.team, `${path}.team`);
  assertEnum(steal.result, ['success', 'failed', null] as const, `${path}.result`);
  if (steal.status === 'unavailable' && (steal.team !== null || steal.result !== null)) {
    fail(path, 'unavailable steal must not have a team or result');
  }
  if (steal.status === 'available' && (steal.team === null || steal.result !== null)) {
    fail(path, 'available steal requires a team and no result');
  }
  if (steal.status === 'used' && (steal.team === null || steal.result === null)) {
    fail(path, 'used steal requires a team and a result');
  }
}

function validateScoreAward(value: unknown, path: string): void {
  if (value === null) return;
  assertShape(value, path, ['team', 'points', 'reason']);
  const award = value as Record<string, unknown>;
  assertTeam(award.team, `${path}.team`);
  assertNonNegativeSafeInteger(award.points, `${path}.points`);
  assertEnum(award.reason, AWARD_REASONS, `${path}.reason`);
}

function validateEvent(value: unknown, expectedSequence: number, path: string): void {
  assertShape(value, path, ['sequence', 'type'], [
    'roundNumber',
    'team',
    'answerId',
    'revealId',
    'correct',
    'points',
    'reason',
  ]);
  const event = value as Record<string, unknown>;
  if (event.sequence !== expectedSequence) fail(`${path}.sequence`, `must be ${expectedSequence}`);
  assertEnum(event.type, EVENT_TYPES, `${path}.type`);
  if (event.roundNumber !== undefined) assertRoundNumber(event.roundNumber, `${path}.roundNumber`);
  if (event.team !== undefined) assertTeam(event.team, `${path}.team`);
  if (event.answerId !== undefined) assertNonEmptyString(event.answerId, `${path}.answerId`);
  if (event.revealId !== undefined) assertPositiveSafeInteger(event.revealId, `${path}.revealId`);
  if (event.correct !== undefined) assertBoolean(event.correct, `${path}.correct`);
  if (event.points !== undefined) assertNonNegativeSafeInteger(event.points, `${path}.points`);
  if (event.reason !== undefined) assertEnum(event.reason, AWARD_REASONS, `${path}.reason`);
}

function validateRoundEvents(round: RoundState, roundNumber: RoundNumber, events: readonly GameEvent[]): void {
  const roundEvents = events.filter((event) => event.roundNumber === roundNumber);
  const activeReveals = new Map<string, { revealId: number; team: Team }>();
  let revealCount = 0;
  for (const event of roundEvents) {
    if (event.type === 'answer_revealed') {
      revealCount += 1;
      if (!event.answerId || !event.team || event.revealId !== revealCount) {
        fail(`$.state.events[${event.sequence - 1}]`, 'answer reveal event is incomplete or out of sequence');
      }
      activeReveals.set(event.answerId, { revealId: event.revealId, team: event.team });
    }
    if (event.type === 'answer_retracted') {
      if (!event.answerId || !event.revealId || activeReveals.get(event.answerId)?.revealId !== event.revealId) {
        fail(`$.state.events[${event.sequence - 1}]`, 'answer retraction does not match an active reveal');
      }
      activeReveals.delete(event.answerId);
    }
  }
  if (revealCount !== round.revealSequence) {
    fail(`$.state.rounds[${roundNumber - 1}].revealSequence`, 'must match the answer_revealed event count');
  }

  for (const answer of round.answers) {
    const activeReveal = activeReveals.get(answer.id);
    if (answer.revealed) {
      if (
        !activeReveal
        || activeReveal.revealId !== answer.activeRevealId
        || activeReveal.team !== answer.revealedByTeam
      ) {
        fail(`$.state.rounds[${roundNumber - 1}].answers`, `answer ${answer.id} does not match its reveal events`);
      }
    } else if (activeReveal) {
      fail(`$.state.rounds[${roundNumber - 1}].answers`, `answer ${answer.id} is hidden despite an active reveal`);
    }
  }

  const resolution = round.ownershipResolution;
  if (resolution) {
    const ownershipEvent = events.find((event) => (
      event.sequence === resolution.id
      && event.roundNumber === roundNumber
      && event.type === 'ownership_answered'
      && event.correct === true
      && event.team === resolution.team
    ));
    if (!ownershipEvent) fail(`$.state.rounds[${roundNumber - 1}].ownershipResolution`, 'does not match an accepted ownership event');
    const retractedAfterResolution = roundEvents.some((event) => (
      event.sequence > resolution.id
      && event.type === 'ownership_answer_retracted'
      && event.team === resolution.team
    ));
    if (resolution.retracted !== retractedAfterResolution) {
      fail(`$.state.rounds[${roundNumber - 1}].ownershipResolution.retracted`, 'does not match the ownership event history');
    }
  }

  if (round.phase === 'completed') {
    const awardEvent = [...roundEvents].reverse().find((event) => event.type === 'round_completed');
    if (
      !awardEvent
      || awardEvent.team !== round.scoreAward?.team
      || awardEvent.points !== round.scoreAward?.points
      || awardEvent.reason !== round.scoreAward?.reason
    ) {
      fail(`$.state.rounds[${roundNumber - 1}].scoreAward`, 'does not match the latest round_completed event');
    }
  }
}

function validateRoundPhase(round: RoundState, questionTotal: number, path: string): void {
  const hasRevealedAnswer = round.answers.some((answer) => answer.revealed);
  const hasAward = round.scoreAward !== null;
  const ownershipPending = round.pendingOwnershipDecisionTeam !== null;
  const commonUnstarted = round.firstBuzzTeam === null
    && round.ownershipTurnTeam === null
    && round.ownerTeam === null
    && round.answeringTeam === null
    && round.ownershipMisses === 0
    && !ownershipPending
    && round.ownershipResolution === null
    && round.mainPlayErrors === 0
    && round.pendingRetractedAnswerTeam === null
    && round.steal.status === 'unavailable'
    && round.questionPoints === 0
    && round.revealSequence === 0
    && !hasRevealedAnswer
    && !hasAward;

  if (round.phase === 'pending' || round.phase === 'toss') {
    if (!commonUnstarted) fail(`${path}.phase`, 'has fields inconsistent with an unstarted round');
    return;
  }
  if (round.phase === 'ownership') {
    if (
      round.firstBuzzTeam === null
      || round.ownershipTurnTeam === null
      || round.ownerTeam !== null
      || round.answeringTeam !== null
      || round.mainPlayErrors !== 0
      || round.steal.status !== 'unavailable'
      || round.questionPoints !== 0
      || round.revealSequence !== 0
      || hasRevealedAnswer
      || hasAward
      || (ownershipPending && round.pendingOwnershipDecisionTeam !== round.ownershipTurnTeam)
      || (round.ownershipResolution !== null && !round.ownershipResolution.retracted)
    ) {
      fail(`${path}.phase`, 'has fields inconsistent with ownership selection');
    }
    return;
  }

  const hasResolvedOwner = round.firstBuzzTeam !== null
    && round.ownerTeam !== null
    && round.answeringTeam !== null
    && round.ownershipTurnTeam === null
    && !ownershipPending
    && round.ownershipResolution !== null
    && !round.ownershipResolution.retracted
    && round.ownershipResolution.team === round.ownerTeam;
  if (!hasResolvedOwner) fail(`${path}.phase`, 'requires a resolved owner and an answering team');

  if (round.phase === 'main_play') {
    if (
      round.mainPlayErrors > 2
      || round.steal.status !== 'unavailable'
      || hasAward
    ) {
      fail(`${path}.phase`, 'has fields inconsistent with main play');
    }
    return;
  }
  if (round.phase === 'steal') {
    if (
      round.mainPlayErrors !== 3
      || round.steal.status !== 'available'
      || round.steal.team !== opposite(round.ownerTeam as Team)
      || round.steal.result !== null
      || round.pendingRetractedAnswerTeam !== null
      || hasAward
    ) {
      fail(`${path}.phase`, 'has fields inconsistent with a pending steal');
    }
    return;
  }

  const award = round.scoreAward;
  if (!award) fail(`${path}.scoreAward`, 'is required for a completed round');
  if (award.points !== questionTotal) fail(`${path}.scoreAward.points`, 'must equal the total question points');
  if (award.reason === 'all_answers_revealed') {
    if (!round.answers.every((answer) => answer.revealed) || round.steal.status !== 'unavailable') {
      fail(`${path}.scoreAward.reason`, 'requires every answer to be revealed without a steal');
    }
  } else {
    const expectedResult = award.reason === 'steal_success' ? 'success' : 'failed';
    const expectedTeam = award.reason === 'steal_success' ? opposite(round.ownerTeam as Team) : round.ownerTeam;
    if (
      round.mainPlayErrors !== 3
      || round.steal.status !== 'used'
      || round.steal.result !== expectedResult
      || round.steal.team !== opposite(round.ownerTeam as Team)
      || award.team !== expectedTeam
      || round.pendingRetractedAnswerTeam !== null
    ) {
      fail(`${path}.scoreAward.reason`, 'does not match the resolved steal');
    }
  }
}

function validateMatchProgression(state: GameState): void {
  const rounds = state.rounds;
  if (state.status === 'setup') {
    if (state.currentRoundNumber !== null || state.outcome !== null || rounds.some((round) => round.phase !== 'pending')) {
      fail('$.state.status', 'setup match must have three pending rounds and no current round');
    }
    return;
  }
  if (state.currentRoundNumber === null) fail('$.state.currentRoundNumber', 'is required after setup');

  const currentIndex = state.currentRoundNumber - 1;
  rounds.forEach((round, index) => {
    if (index < currentIndex && round.phase !== 'completed') {
      fail(`$.state.rounds[${index}]`, 'previous rounds must be completed');
    }
    if (index > currentIndex && round.phase !== 'pending') {
      fail(`$.state.rounds[${index}]`, 'future rounds must be pending');
    }
  });

  const currentRound = rounds[currentIndex];
  if (state.status === 'completed') {
    if (state.currentRoundNumber !== 3 || rounds.some((round) => round.phase !== 'completed')) {
      fail('$.state.status', 'completed match must have completed all three rounds');
    }
    const expectedOutcome: MatchOutcome = state.teamScores.team_one === state.teamScores.team_two
      ? 'tie'
      : state.teamScores.team_one > state.teamScores.team_two ? 'team_one' : 'team_two';
    if (state.outcome !== expectedOutcome) fail('$.state.outcome', 'does not match final team scores');
  } else if (state.outcome !== null || currentRound.phase === 'pending') {
    fail('$.state.status', 'active or paused match has an invalid outcome or current round');
  }
}

function validateTeamScoreTotals(state: GameState): void {
  const totals: Record<Team, number> = { team_one: 0, team_two: 0 };
  for (const round of state.rounds) {
    if (!round.scoreAward) continue;
    const next = safeAdd(totals[round.scoreAward.team], round.scoreAward.points);
    if (next === null) fail('$.state.teamScores', 'round awards exceed the safe integer range');
    totals[round.scoreAward.team] = next;
  }
  if (totals.team_one !== state.teamScores.team_one || totals.team_two !== state.teamScores.team_two) {
    fail('$.state.teamScores', 'must equal the sum of current round awards');
  }
}

function sumSafe(values: readonly number[], path: string): number {
  let total = 0;
  for (const value of values) {
    const next = safeAdd(total, value);
    if (next === null) fail(path, 'sum exceeds Number.MAX_SAFE_INTEGER');
    total = next;
  }
  return total;
}

function safeAdd(left: number, right: number): number | null {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right) || left < 0 || right < 0) return null;
  if (left > Number.MAX_SAFE_INTEGER - right) return null;
  return left + right;
}

function assertShape(
  value: unknown,
  path: string,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): asserts value is Record<string, unknown> {
  if (!isRecord(value)) fail(path, 'must be an object');
  for (const key of requiredKeys) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${path}.${key}`, 'is required');
  }
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${path}.${key}`, 'is not part of this schema version');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertEnum<T extends string | number | null>(value: unknown, values: readonly T[], path: string): asserts value is T {
  if (!values.some((candidate) => candidate === value)) fail(path, 'has an unsupported value');
}

function assertNonEmptyString(value: unknown, path: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') fail(path, 'must be a non-empty string');
}

function assertBoolean(value: unknown, path: string): asserts value is boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean');
}

function assertNonNegativeSafeInteger(value: unknown, path: string): asserts value is number {
  if (!isSafeInteger(value) || value < 0) fail(path, 'must be a non-negative safe integer');
}

function assertPositiveSafeInteger(value: unknown, path: string): asserts value is number {
  if (!isSafeInteger(value) || value < 1) fail(path, 'must be a positive safe integer');
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function assertTeam(value: unknown, path: string): asserts value is Team {
  assertEnum(value, TEAM_VALUES, path);
}

function assertTeamOrNull(value: unknown, path: string): asserts value is Team | null {
  assertEnum(value, [...TEAM_VALUES, null], path);
}

function assertRoundNumber(value: unknown, path: string): asserts value is RoundNumber {
  assertEnum(value, [1, 2, 3] as const, path);
}

function assertRoundNumberOrNull(value: unknown, path: string): asserts value is RoundNumber | null {
  assertEnum(value, [1, 2, 3, null] as const, path);
}

function opposite(team: Team): Team {
  return team === 'team_one' ? 'team_two' : 'team_one';
}

function fail(path: string, message: string): never {
  throw new GameStateSerializationError(`Invalid game state at ${path}: ${message}.`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
