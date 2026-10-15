import {
  AnswerDefinition,
  CommandResult,
  GameCommand,
  GameErrorCode,
  GameEvent,
  GameState,
  MatchDefinition,
  RoundAnswer,
  RoundDefinition,
  RoundNumber,
  RoundState,
  ScoreAward,
  Team,
  opposingTeam,
} from './types';

const ROUND_NUMBERS: readonly [RoundNumber, RoundNumber, RoundNumber] = [1, 2, 3];

export function createGameState(definition: MatchDefinition): GameState {
  if (!definition.id.trim() || definition.rounds.length !== 3) {
    throw new TypeError('A match requires an id and exactly three rounds.');
  }

  const rounds = definition.rounds.map((round, index) => createRound(round, ROUND_NUMBERS[index])) as [
    RoundState,
    RoundState,
    RoundState,
  ];

  return {
    id: definition.id,
    status: 'setup',
    rounds,
    currentRoundNumber: null,
    teamScores: { team_one: 0, team_two: 0 },
    outcome: null,
    revision: 0,
    nextEventSequence: 1,
    events: [],
  };
}

function createRound(definition: RoundDefinition, number: RoundNumber): RoundState {
  const questionIsValid = definition.questionId.trim() !== '' && definition.questionText.trim() !== '';
  const answerIds = new Set<string>();
  const answersAreValid = definition.answers.length > 0 && definition.answers.every((answer) => {
    if (!isValidAnswer(answer) || answerIds.has(answer.id)) return false;
    answerIds.add(answer.id);
    return true;
  });
  const questionPoints = answersAreValid ? totalAnswerPoints(definition.answers) : null;

  if (!questionIsValid || !answersAreValid || questionPoints === null) {
    throw new TypeError(`Round ${number} requires a question and unique, valid answers.`);
  }

  return {
    number,
    phase: 'pending',
    questionId: definition.questionId,
    questionText: definition.questionText,
    answers: definition.answers.map((answer) => ({
      ...answer,
      revealed: false,
      activeRevealId: null,
      revealedByTeam: null,
    })),
    firstBuzzTeam: null,
    ownershipTurnTeam: null,
    ownerTeam: null,
    answeringTeam: null,
    ownershipMisses: 0,
    pendingOwnershipDecisionTeam: null,
    ownershipResolution: null,
    mainPlayErrors: 0,
    pendingRetractedAnswerTeam: null,
    steal: { status: 'unavailable', team: null, result: null },
    questionPoints: 0,
    revealSequence: 0,
    scoreAward: null,
  };
}

function isValidAnswer(answer: AnswerDefinition): boolean {
  return answer.id.trim() !== ''
    && answer.text.trim() !== ''
    && Number.isSafeInteger(answer.points)
    && answer.points >= 0;
}

function safeAddNonNegative(left: number, right: number): number | null {
  if (
    !Number.isSafeInteger(left)
    || !Number.isSafeInteger(right)
    || left < 0
    || right < 0
    || left > Number.MAX_SAFE_INTEGER - right
  ) {
    return null;
  }
  return left + right;
}

function safeSubtractNonNegative(left: number, right: number): number | null {
  if (
    !Number.isSafeInteger(left)
    || !Number.isSafeInteger(right)
    || left < right
    || right < 0
  ) {
    return null;
  }
  return left - right;
}

function totalAnswerPoints(answers: readonly AnswerDefinition[]): number | null {
  let total = 0;
  for (const answer of answers) {
    const next = safeAddNonNegative(total, answer.points);
    if (next === null) return null;
    total = next;
  }
  return total;
}

export function applyGameCommand(state: GameState, command: GameCommand): CommandResult {
  if (state.status === 'paused_host_disconnected' && command.type !== 'resume_by_host') {
    return reject(state, 'match_is_paused');
  }

  switch (command.type) {
    case 'start_match':
      return startMatch(state);
    case 'accept_buzz':
      return acceptBuzz(state, command.team);
    case 'submit_ownership_answer':
      return submitOwnershipAnswer(state, command.team, command.correct);
    case 'transfer_ownership_turn':
      return transferOwnershipTurn(state);
    case 'retract_ownership_answer':
      return retractOwnershipAnswer(state, command.resolutionId);
    case 'record_ownership_error':
      return recordOwnershipError(state);
    case 'grant_ownership_retry':
      return grantOwnershipRetry(state);
    case 'reveal_answer':
      return revealAnswer(state, command.answerId);
    case 'retract_answer':
      return retractAnswer(state, command.answerId, command.revealId);
    case 'grant_play_attempt':
      return grantPlayAttempt(state, command.team);
    case 'record_play_error':
      return recordPlayError(state, command.team);
    case 'resolve_steal':
      return resolveSteal(state, command.correct);
    case 'advance_round':
      return advanceRound(state);
    case 'pause_for_host_disconnect':
      return pauseMatch(state);
    case 'resume_by_host':
      return resumeMatch(state);
    default:
      return reject(state, 'invalid_round_phase');
  }
}

function startMatch(state: GameState): CommandResult {
  if (state.status !== 'setup' || state.currentRoundNumber !== null) {
    return reject(state, 'match_not_in_setup');
  }

  const firstRound = { ...state.rounds[0], phase: 'toss' as const };
  const next = replaceRound({ ...state, status: 'in_progress', currentRoundNumber: 1 }, firstRound);
  return accept(next, [{ type: 'match_started', roundNumber: 1 }]);
}

function acceptBuzz(state: GameState, team: Team): CommandResult {
  const round = activeRound(state);
  if (!round) return reject(state, 'no_current_round');
  if (round.phase !== 'toss') return reject(state, round.firstBuzzTeam ? 'buzz_already_accepted' : 'invalid_round_phase');

  const nextRound: RoundState = {
    ...round,
    phase: 'ownership',
    firstBuzzTeam: team,
    ownershipTurnTeam: team,
  };
  return accept(replaceRound(state, nextRound), [{ type: 'buzz_accepted', roundNumber: round.number, team }]);
}

function submitOwnershipAnswer(state: GameState, team: Team, correct: boolean): CommandResult {
  const round = activeRound(state);
  if (!round) return reject(state, 'no_current_round');
  if (round.phase !== 'ownership') return reject(state, 'invalid_round_phase');
  if (round.pendingOwnershipDecisionTeam !== null) return reject(state, 'ownership_decision_pending');
  if (team !== round.ownershipTurnTeam) return reject(state, 'wrong_team');

  if (!correct) {
    const nextRound: RoundState = {
      ...round,
      ownershipTurnTeam: opposingTeam(team),
      ownershipMisses: round.ownershipMisses + 1,
    };
    return accept(replaceRound(state, nextRound), [
      { type: 'ownership_answered', roundNumber: round.number, team, correct: false },
    ]);
  }

  const resolutionId = state.nextEventSequence;
  const nextRound: RoundState = {
    ...round,
    phase: 'main_play',
    ownershipTurnTeam: null,
    ownerTeam: team,
    answeringTeam: team,
    mainPlayErrors: 0,
    ownershipResolution: { id: resolutionId, team, retracted: false },
  };
  return accept(replaceRound(state, nextRound), [
    { type: 'ownership_answered', roundNumber: round.number, team, correct: true },
  ]);
}

function transferOwnershipTurn(state: GameState): CommandResult {
  const round = activeRound(state);
  if (!round) return reject(state, 'no_current_round');
  if (round.phase !== 'ownership') return reject(state, 'invalid_round_phase');
  if (round.pendingOwnershipDecisionTeam !== null) return reject(state, 'ownership_decision_pending');
  if (!round.ownershipTurnTeam) return reject(state, 'invalid_round_phase');

  const from = round.ownershipTurnTeam;
  const to = opposingTeam(from);
  return accept(
    replaceRound(state, { ...round, ownershipTurnTeam: to }),
    [{ type: 'ownership_turn_transferred', roundNumber: round.number, team: to }],
  );
}

function retractOwnershipAnswer(state: GameState, resolutionId: number): CommandResult {
  const round = activeRound(state);
  if (!round) return reject(state, 'no_current_round');
  const resolution = round.ownershipResolution;
  if (
    round.phase !== 'main_play'
    || !resolution
    || resolution.id !== resolutionId
    || resolution.retracted
    || round.mainPlayErrors !== 0
    || round.questionPoints !== 0
    || round.answers.some((answer) => answer.revealed)
  ) {
    return reject(state, 'no_retractable_ownership_answer');
  }

  const nextRound: RoundState = {
    ...round,
    phase: 'ownership',
    ownershipTurnTeam: resolution.team,
    ownerTeam: null,
    answeringTeam: null,
    pendingOwnershipDecisionTeam: resolution.team,
    ownershipResolution: { ...resolution, retracted: true },
  };
  return accept(replaceRound(state, nextRound), [
    { type: 'ownership_answer_retracted', roundNumber: round.number, team: resolution.team },
  ]);
}

function recordOwnershipError(state: GameState): CommandResult {
  const round = activeRound(state);
  if (!round) return reject(state, 'no_current_round');
  if (round.phase !== 'ownership' || round.pendingOwnershipDecisionTeam === null) {
    return reject(state, 'ownership_decision_pending');
  }

  const team = round.pendingOwnershipDecisionTeam;
  const nextRound: RoundState = {
    ...round,
    ownershipTurnTeam: opposingTeam(team),
    ownershipMisses: round.ownershipMisses + 1,
    pendingOwnershipDecisionTeam: null,
  };
  return accept(replaceRound(state, nextRound), [
    { type: 'ownership_error_recorded', roundNumber: round.number, team, correct: false },
  ]);
}

function grantOwnershipRetry(state: GameState): CommandResult {
  const round = activeRound(state);
  if (!round) return reject(state, 'no_current_round');
  if (round.phase !== 'ownership' || round.pendingOwnershipDecisionTeam === null) {
    return reject(state, 'ownership_decision_pending');
  }

  const team = round.pendingOwnershipDecisionTeam;
  const nextRound: RoundState = { ...round, ownershipTurnTeam: team, pendingOwnershipDecisionTeam: null };
  return accept(replaceRound(state, nextRound), [
    { type: 'ownership_retry_granted', roundNumber: round.number, team },
  ]);
}

function revealAnswer(state: GameState, answerId: string): CommandResult {
  const round = activeRound(state);
  if (!round) return reject(state, 'no_current_round');
  if (round.phase !== 'main_play') return reject(state, 'invalid_round_phase');
  if (round.pendingRetractedAnswerTeam !== null) return reject(state, 'play_retraction_pending');

  const answerIndex = round.answers.findIndex((answer) => answer.id === answerId);
  if (answerIndex < 0) return reject(state, 'answer_not_found');
  const answer = round.answers[answerIndex];
  if (answer.revealed) return reject(state, 'answer_already_revealed');
  if (!round.answeringTeam || !round.ownerTeam) return reject(state, 'invalid_round_phase');
  const questionPoints = safeAddNonNegative(round.questionPoints, answer.points);
  if (questionPoints === null) return reject(state, 'unsafe_score_calculation');

  const revealId = round.revealSequence + 1;
  const nextAnswer: RoundAnswer = {
    ...answer,
    revealed: true,
    activeRevealId: revealId,
    revealedByTeam: round.answeringTeam,
  };
  const answers = round.answers.map((item, index) => index === answerIndex ? nextAnswer : item);
  let nextRound: RoundState = {
    ...round,
    answers,
    questionPoints,
    revealSequence: revealId,
  };
  const event: GameEvent = {
    sequence: state.nextEventSequence,
    type: 'answer_revealed',
    roundNumber: round.number,
    team: round.answeringTeam,
    answerId,
    revealId,
    points: answer.points,
  };
  const events: GameEvent[] = [event];

  if (answers.every((item) => item.revealed)) {
    const totalPoints = totalQuestionPoints(nextRound);
    if (totalPoints === null) return reject(state, 'unsafe_score_calculation');
    const completion = completeRound(
      replaceRound(state, nextRound),
      nextRound,
      round.ownerTeam,
      totalPoints,
      'all_answers_revealed',
    );
    if (!completion) return reject(state, 'unsafe_score_calculation');
    const completionEvent: GameEvent = {
      ...completion.event,
      sequence: event.sequence + 1,
    };
    events.push(completionEvent);
    return acceptWithEvents(completion.state, events);
  }
  return acceptWithEvents(replaceRound(state, nextRound), events);
}

function retractAnswer(state: GameState, answerId: string, revealId: number): CommandResult {
  const round = activeRound(state);
  if (!round) return reject(state, 'no_current_round');
  const retractingCompletedRound = round.phase === 'completed'
    && round.scoreAward?.reason === 'all_answers_revealed';
  if (round.phase !== 'main_play' && !retractingCompletedRound) return reject(state, 'invalid_round_phase');
  if (round.pendingRetractedAnswerTeam !== null) return reject(state, 'play_retraction_pending');

  const answerIndex = round.answers.findIndex((answer) => answer.id === answerId);
  if (answerIndex < 0) return reject(state, 'answer_not_found');
  const answer = round.answers[answerIndex];
  if (!answer.revealed || answer.activeRevealId === null) return reject(state, 'answer_not_revealed');
  if (answer.activeRevealId !== revealId) return reject(state, 'stale_reveal');
  if (answer.revealedByTeam === null) return reject(state, 'invalid_round_phase');
  const questionPoints = safeSubtractNonNegative(round.questionPoints, answer.points);
  if (questionPoints === null) return reject(state, 'unsafe_score_calculation');

  const answeringTeam = answer.revealedByTeam;
  const nextAnswer: RoundAnswer = {
    ...answer,
    revealed: false,
    activeRevealId: null,
    revealedByTeam: null,
  };
  const answers = round.answers.map((item, index) => index === answerIndex ? nextAnswer : item);
  const scoreAward = retractingCompletedRound ? round.scoreAward : null;
  let adjustedState = state;
  if (scoreAward) {
    const adjustedTeamScore = safeSubtractNonNegative(state.teamScores[scoreAward.team], scoreAward.points);
    if (adjustedTeamScore === null) return reject(state, 'unsafe_score_calculation');
    adjustedState = {
      ...state,
      teamScores: { ...state.teamScores, [scoreAward.team]: adjustedTeamScore },
    };
  }
  const nextRound: RoundState = {
    ...round,
    phase: 'main_play',
    answers,
    scoreAward: null,
    questionPoints,
    pendingRetractedAnswerTeam: answeringTeam,
  };
  return accept(replaceRound(adjustedState, nextRound), [
    { type: 'answer_retracted', roundNumber: round.number, team: answeringTeam, answerId, revealId, points: answer.points },
  ]);
}

function grantPlayAttempt(state: GameState, team: Team): CommandResult {
  const round = activeRound(state);
  if (!round) return reject(state, 'no_current_round');
  if (round.phase !== 'main_play') return reject(state, 'invalid_round_phase');
  if (round.pendingRetractedAnswerTeam === null) return reject(state, 'no_play_retraction_pending');

  const nextRound: RoundState = {
    ...round,
    answeringTeam: team,
    pendingRetractedAnswerTeam: null,
  };
  return accept(replaceRound(state, nextRound), [
    { type: 'play_attempt_granted', roundNumber: round.number, team },
  ]);
}

function recordPlayError(state: GameState, team: Team): CommandResult {
  const round = activeRound(state);
  if (!round) return reject(state, 'no_current_round');
  if (round.phase !== 'main_play') return reject(state, 'invalid_round_phase');
  if (round.pendingRetractedAnswerTeam !== null) {
    if (team !== round.pendingRetractedAnswerTeam) return reject(state, 'wrong_team');
  } else if (team !== round.answeringTeam) {
    return reject(state, 'wrong_team');
  }
  if (!round.ownerTeam || round.mainPlayErrors >= 3) return reject(state, 'invalid_round_phase');

  const mainPlayErrors = round.mainPlayErrors + 1;
  const opensSteal = mainPlayErrors === 3;
  const nextRound: RoundState = {
    ...round,
    phase: opensSteal ? 'steal' : 'main_play',
    mainPlayErrors,
    pendingRetractedAnswerTeam: null,
    steal: opensSteal
      ? { status: 'available', team: opposingTeam(round.ownerTeam), result: null }
      : round.steal,
  };
  const events: Omit<GameEvent, 'sequence'>[] = [
    { type: 'play_error_recorded', roundNumber: round.number, team, correct: false },
  ];
  if (opensSteal) events.push({ type: 'steal_opened', roundNumber: round.number, team: opposingTeam(round.ownerTeam) });
  return accept(replaceRound(state, nextRound), events);
}

function resolveSteal(state: GameState, correct: boolean): CommandResult {
  const round = activeRound(state);
  if (!round) return reject(state, 'no_current_round');
  if (round.phase !== 'steal' || round.steal.status !== 'available' || !round.steal.team || !round.ownerTeam) {
    return reject(state, 'invalid_steal');
  }

  const points = totalQuestionPoints(round);
  if (points === null) return reject(state, 'unsafe_score_calculation');
  const team = correct ? round.steal.team : round.ownerTeam;
  const reason: ScoreAward['reason'] = correct ? 'steal_success' : 'steal_failed';
  const completion = completeRound(state, round, team, points, reason);
  if (!completion) return reject(state, 'unsafe_score_calculation');
  const completedRound = completion.state.rounds[round.number - 1];
  const nextRound: RoundState = {
    ...completedRound,
    steal: { status: 'used', team: round.steal.team, result: correct ? 'success' : 'failed' },
  };
  return accept(replaceRound(completion.state, nextRound), [
    { type: 'steal_resolved', roundNumber: round.number, team: round.steal.team, correct },
    completion.event,
  ]);
}

function advanceRound(state: GameState): CommandResult {
  const round = activeRound(state);
  if (!round) return reject(state, 'no_current_round');
  if (round.phase !== 'completed' || !round.scoreAward) return reject(state, 'round_not_complete');
  if (state.currentRoundNumber === null) return reject(state, 'no_current_round');

  if (round.number === 3) {
    const outcome = state.teamScores.team_one === state.teamScores.team_two
      ? 'tie'
      : state.teamScores.team_one > state.teamScores.team_two ? 'team_one' : 'team_two';
    return accept({ ...state, status: 'completed', outcome }, [
      { type: 'match_completed', roundNumber: 3, team: outcome === 'tie' ? undefined : outcome },
    ]);
  }

  const nextNumber = (round.number + 1) as RoundNumber;
  const nextRound = { ...state.rounds[nextNumber - 1], phase: 'toss' as const };
  const next = replaceRound({ ...state, currentRoundNumber: nextNumber }, nextRound);
  return accept(next, [{ type: 'round_advanced', roundNumber: nextNumber }]);
}

function pauseMatch(state: GameState): CommandResult {
  if (state.status !== 'in_progress') return reject(state, 'match_not_in_progress');
  return accept({ ...state, status: 'paused_host_disconnected' }, [
    { type: 'match_paused', roundNumber: state.currentRoundNumber ?? undefined },
  ]);
}

function resumeMatch(state: GameState): CommandResult {
  if (state.status !== 'paused_host_disconnected') return reject(state, 'match_not_paused');
  return accept({ ...state, status: 'in_progress' }, [
    { type: 'match_resumed', roundNumber: state.currentRoundNumber ?? undefined },
  ]);
}

function completeRound(
  state: GameState,
  round: RoundState,
  team: Team,
  points: number,
  reason: ScoreAward['reason'],
): { state: GameState; event: Omit<GameEvent, 'sequence'> } | null {
  const teamScore = safeAddNonNegative(state.teamScores[team], points);
  if (teamScore === null) return null;

  const award: ScoreAward = { team, points, reason };
  return {
    state: {
      ...replaceRound(state, { ...round, phase: 'completed', scoreAward: award }),
      teamScores: { ...state.teamScores, [team]: teamScore },
    },
    event: { type: 'round_completed', roundNumber: round.number, team, points, reason },
  };
}

function totalQuestionPoints(round: RoundState): number | null {
  return totalAnswerPoints(round.answers);
}

function activeRound(state: GameState): RoundState | null {
  if (state.status !== 'in_progress' || state.currentRoundNumber === null) return null;
  return state.rounds[state.currentRoundNumber - 1];
}

function replaceRound(state: GameState, round: RoundState): GameState {
  switch (round.number) {
    case 1:
      return { ...state, rounds: [round, state.rounds[1], state.rounds[2]] };
    case 2:
      return { ...state, rounds: [state.rounds[0], round, state.rounds[2]] };
    case 3:
      return { ...state, rounds: [state.rounds[0], state.rounds[1], round] };
  }
}

function accept(state: GameState, events: readonly Omit<GameEvent, 'sequence'>[]): CommandResult {
  const appended = events.map((event, index) => ({ ...event, sequence: state.nextEventSequence + index }));
  return acceptWithEvents(state, appended);
}

function acceptWithEvents(state: GameState, events: readonly GameEvent[]): CommandResult {
  const next: GameState = {
    ...state,
    revision: state.revision + 1,
    nextEventSequence: state.nextEventSequence + events.length,
    events: [...state.events, ...events],
  };
  return { ok: true, state: next };
}

function reject(state: GameState, code: GameErrorCode): CommandResult {
  return { ok: false, code, message: messageFor(code), state };
}

function messageFor(code: GameErrorCode): string {
  const messages: Record<GameErrorCode, string> = {
    invalid_match_definition: 'The match definition is invalid.',
    match_not_in_setup: 'The match cannot be started from its current status.',
    match_not_in_progress: 'The match is not in progress.',
    match_is_paused: 'The match is paused until the host resumes it.',
    match_not_paused: 'The match is not paused.',
    no_current_round: 'There is no active round.',
    invalid_round_phase: 'The command is not valid in this round phase.',
    wrong_team: 'The command does not match the team entitled to act.',
    buzz_already_accepted: 'The first buzz has already been accepted.',
    ownership_decision_pending: 'The host must resolve the retracted ownership answer first.',
    no_retractable_ownership_answer: 'There is no retractable ownership answer.',
    answer_not_found: 'The answer does not exist in this round.',
    answer_already_revealed: 'The answer is already revealed.',
    answer_not_revealed: 'The answer is not currently revealed.',
    stale_reveal: 'The reveal id does not match the active reveal.',
    play_retraction_pending: 'The host must resolve the retracted answer first.',
    no_play_retraction_pending: 'There is no retracted play answer to resolve.',
    invalid_steal: 'There is no available steal attempt.',
    unsafe_score_calculation: 'The score calculation exceeds the supported safe integer range.',
    round_not_complete: 'The current round has not been completed.',
    round_already_awarded: 'The round points have already been awarded.',
  };
  return messages[code];
}
