import { applyGameCommand, createGameState } from './game-domain';
import { GameCommand, GameState, MatchDefinition, RoundDefinition, RoundState, Team } from './types';

type AnswerPoints = readonly [number, number];
type MatchRoundPoints = readonly [AnswerPoints, AnswerPoints, AnswerPoints];

function roundDefinition(number: number, points: AnswerPoints = [40, 20]): RoundDefinition {
  return {
    questionId: `question-${number}`,
    questionText: `Question ${number}`,
    answers: [
      { id: `answer-${number}-a`, text: 'First answer', points: points[0] },
      { id: `answer-${number}-b`, text: 'Second answer', points: points[1] },
    ],
  };
}

function newGame(thirdRoundPoints: AnswerPoints = [40, 20]): GameState {
  return gameWithRoundPoints([[40, 20], [40, 20], thirdRoundPoints]);
}

function gameWithRoundPoints(points: MatchRoundPoints): GameState {
  const definition: MatchDefinition = {
    id: 'match-1',
    rounds: [roundDefinition(1, points[0]), roundDefinition(2, points[1]), roundDefinition(3, points[2])],
  };
  return createGameState(definition);
}

function send(state: GameState, command: GameCommand): GameState {
  const result = applyGameCommand(state, command);
  if (!result.ok) throw new Error(`Unexpected rejection: ${result.code}`);
  return result.state;
}

function expectRejected(state: GameState, command: GameCommand, expectedCode?: string): void {
  const before = structuredClone(state);
  const result = applyGameCommand(state, command);
  expect(result.ok).toBe(false);
  if (result.ok) throw new Error('Expected command to be rejected.');
  if (expectedCode) expect(result.code).toBe(expectedCode);
  expect(result.state).toBe(state);
  expect(state).toEqual(before);
}

function startedGame(): GameState {
  return send(newGame(), { type: 'start_match' });
}

function ownershipGame(firstBuzzTeam: Team = 'team_one'): GameState {
  return send(startedGame(), { type: 'accept_buzz', team: firstBuzzTeam });
}

function mainPlayGame(owner: Team = 'team_one'): GameState {
  return send(ownershipGame(owner), { type: 'submit_ownership_answer', team: owner, correct: true });
}

function currentRound(state: GameState): RoundState {
  if (state.currentRoundNumber === null) throw new Error('Expected a current round.');
  return state.rounds[state.currentRoundNumber - 1];
}

function recordErrors(state: GameState, team: Team, count: number): GameState {
  let next = state;
  for (let index = 0; index < count; index += 1) {
    next = send(next, { type: 'record_play_error', team });
  }
  return next;
}

describe('game domain core', () => {
  it('creates a three-round match and pending rounds with empty scores', () => {
    const state = newGame();

    expect(state.status).toBe('setup');
    expect(state.rounds.map((round) => round.phase)).toEqual(['pending', 'pending', 'pending']);
    expect(state.teamScores).toEqual({ team_one: 0, team_two: 0 });
    expect(state.outcome).toBeNull();
  });

  it('rejects a question whose answer points exceed Number.MAX_SAFE_INTEGER', () => {
    expect(() => gameWithRoundPoints([
      [Number.MAX_SAFE_INTEGER, 1],
      [40, 20],
      [40, 20],
    ])).toThrow(TypeError);
  });

  it('accepts and awards a question total exactly equal to Number.MAX_SAFE_INTEGER', () => {
    let state = send(gameWithRoundPoints([
      [Number.MAX_SAFE_INTEGER - 1, 1],
      [0, 0],
      [0, 0],
    ]), { type: 'start_match' });
    state = send(state, { type: 'accept_buzz', team: 'team_one' });
    state = send(state, { type: 'submit_ownership_answer', team: 'team_one', correct: true });
    state = send(state, { type: 'reveal_answer', answerId: 'answer-1-a' });
    state = send(state, { type: 'reveal_answer', answerId: 'answer-1-b' });

    expect(currentRound(state).questionPoints).toBe(Number.MAX_SAFE_INTEGER);
    expect(state.teamScores.team_one).toBe(Number.MAX_SAFE_INTEGER);
  });

  it('rejects an unsafe team-score addition without changing state or events', () => {
    let state = send(gameWithRoundPoints([
      [Number.MAX_SAFE_INTEGER, 0],
      [1, 0],
      [0, 0],
    ]), { type: 'start_match' });
    state = send(state, { type: 'accept_buzz', team: 'team_one' });
    state = send(state, { type: 'submit_ownership_answer', team: 'team_one', correct: true });
    state = send(state, { type: 'reveal_answer', answerId: 'answer-1-a' });
    state = send(state, { type: 'reveal_answer', answerId: 'answer-1-b' });
    state = send(state, { type: 'advance_round' });
    state = send(state, { type: 'accept_buzz', team: 'team_one' });
    state = send(state, { type: 'submit_ownership_answer', team: 'team_one', correct: true });
    state = send(state, { type: 'reveal_answer', answerId: 'answer-2-a' });
    const eventCount = state.events.length;

    const result = applyGameCommand(state, { type: 'reveal_answer', answerId: 'answer-2-b' });

    expect(result).toMatchObject({ ok: false, code: 'unsafe_score_calculation' });
    expect(result.state).toBe(state);
    expect(result.state.events).toHaveLength(eventCount);
    expect(result.state.teamScores.team_one).toBe(Number.MAX_SAFE_INTEGER);
    expect(currentRound(result.state).phase).toBe('main_play');
  });

  it('accepts the first valid buzz and rejects the competing buzz without mutation', () => {
    const state = startedGame();
    const afterFirst = send(state, { type: 'accept_buzz', team: 'team_two' });

    expect(currentRound(afterFirst).firstBuzzTeam).toBe('team_two');
    expect(currentRound(afterFirst).ownershipTurnTeam).toBe('team_two');
    expectRejected(afterFirst, { type: 'accept_buzz', team: 'team_one' }, 'buzz_already_accepted');
    expect(currentRound(afterFirst).firstBuzzTeam).toBe('team_two');
  });

  it('gives the buzz-winning team the first ownership attempt', () => {
    const state = ownershipGame('team_two');

    expect(currentRound(state).phase).toBe('ownership');
    expect(currentRound(state).ownershipTurnTeam).toBe('team_two');
  });

  it('alternates ownership attempts after misses without increasing main-play errors', () => {
    let state = ownershipGame('team_one');
    state = send(state, { type: 'submit_ownership_answer', team: 'team_one', correct: false });
    expect(currentRound(state).ownershipTurnTeam).toBe('team_two');
    state = send(state, { type: 'submit_ownership_answer', team: 'team_two', correct: false });

    expect(currentRound(state).ownershipTurnTeam).toBe('team_one');
    expect(currentRound(state).ownershipMisses).toBe(2);
    expect(currentRound(state).mainPlayErrors).toBe(0);
    expect(currentRound(state).phase).toBe('ownership');
  });

  it('makes the first correct ownership team the owner and starts main play with zero errors', () => {
    const state = send(ownershipGame('team_two'), {
      type: 'submit_ownership_answer',
      team: 'team_two',
      correct: true,
    });

    expect(currentRound(state).phase).toBe('main_play');
    expect(currentRound(state).ownerTeam).toBe('team_two');
    expect(currentRound(state).answeringTeam).toBe('team_two');
    expect(currentRound(state).mainPlayErrors).toBe(0);
  });

  it('allows the host to transfer the ownership turn without reopening the toss', () => {
    const state = ownershipGame('team_one');
    const transferred = send(state, { type: 'transfer_ownership_turn' });

    expect(currentRound(transferred).ownershipTurnTeam).toBe('team_two');
    expect(currentRound(transferred).firstBuzzTeam).toBe('team_one');
    expectRejected(transferred, { type: 'accept_buzz', team: 'team_one' }, 'buzz_already_accepted');
  });

  it('reveals an answer and adds its points to the question subtotal once', () => {
    const state = mainPlayGame();
    const revealed = send(state, { type: 'reveal_answer', answerId: 'answer-1-a' });

    expect(currentRound(revealed).answers[0].revealed).toBe(true);
    expect(currentRound(revealed).questionPoints).toBe(40);
    expect(revealed.teamScores).toEqual({ team_one: 0, team_two: 0 });
  });

  it('rejects revealing an already revealed answer without changing state or score', () => {
    const revealed = send(mainPlayGame(), { type: 'reveal_answer', answerId: 'answer-1-a' });

    expectRejected(revealed, { type: 'reveal_answer', answerId: 'answer-1-a' }, 'answer_already_revealed');
    expect(currentRound(revealed).questionPoints).toBe(40);
  });

  it('opens the single steal phase after three main-play errors', () => {
    const state = recordErrors(mainPlayGame(), 'team_one', 3);

    expect(currentRound(state).phase).toBe('steal');
    expect(currentRound(state).mainPlayErrors).toBe(3);
    expect(currentRound(state).steal).toEqual({ status: 'available', team: 'team_two', result: null });
  });

  it('allows only one steal attempt and rejects any later play command', () => {
    const stealState = recordErrors(mainPlayGame(), 'team_one', 3);
    const resolved = send(stealState, { type: 'resolve_steal', correct: false });

    expect(currentRound(resolved).steal.status).toBe('used');
    expectRejected(resolved, { type: 'resolve_steal', correct: true }, 'invalid_steal');
    expectRejected(resolved, { type: 'record_play_error', team: 'team_one' }, 'invalid_round_phase');
  });

  it('awards the full question value to the stealing team on a successful steal', () => {
    const beforeSteal = send(mainPlayGame(), { type: 'reveal_answer', answerId: 'answer-1-a' });
    const stealState = recordErrors(beforeSteal, 'team_one', 3);
    const resolved = send(stealState, { type: 'resolve_steal', correct: true });

    expect(currentRound(resolved).scoreAward).toEqual({
      team: 'team_two',
      points: 60,
      reason: 'steal_success',
    });
    expect(resolved.teamScores).toEqual({ team_one: 0, team_two: 60 });
    expect(currentRound(resolved).questionPoints).toBe(40);
  });

  it('awards the full question value to the original owner after a failed steal, including hidden answers', () => {
    const stealState = recordErrors(mainPlayGame(), 'team_one', 3);
    const resolved = send(stealState, { type: 'resolve_steal', correct: false });

    expect(currentRound(resolved).scoreAward).toEqual({
      team: 'team_one',
      points: 60,
      reason: 'steal_failed',
    });
    expect(resolved.teamScores).toEqual({ team_one: 60, team_two: 0 });
    expect(currentRound(resolved).answers.some((answer) => !answer.revealed)).toBe(true);
  });

  it('completes a round when all answers are revealed and awards points once', () => {
    let state = mainPlayGame();
    state = send(state, { type: 'reveal_answer', answerId: 'answer-1-a' });
    state = send(state, { type: 'reveal_answer', answerId: 'answer-1-b' });

    expect(currentRound(state).phase).toBe('completed');
    expect(currentRound(state).scoreAward?.points).toBe(60);
    expect(state.teamScores).toEqual({ team_one: 60, team_two: 0 });
    const advanced = send(state, { type: 'advance_round' });
    expect(advanced.teamScores).toEqual({ team_one: 60, team_two: 0 });
    expect(currentRound(advanced).number).toBe(2);
  });

  it('retracts a revealed answer once and can reveal it again with a new reveal id', () => {
    let state = send(mainPlayGame(), { type: 'reveal_answer', answerId: 'answer-1-a' });
    const firstRevealId = currentRound(state).answers[0].activeRevealId;
    if (firstRevealId === null) throw new Error('Expected an active reveal.');
    state = send(state, { type: 'retract_answer', answerId: 'answer-1-a', revealId: firstRevealId });

    expect(currentRound(state).questionPoints).toBe(0);
    expect(currentRound(state).answers[0].revealed).toBe(false);
    expectRejected(state, { type: 'retract_answer', answerId: 'answer-1-a', revealId: firstRevealId });

    state = send(state, { type: 'grant_play_attempt', team: 'team_one' });
    state = send(state, { type: 'reveal_answer', answerId: 'answer-1-a' });
    expect(currentRound(state).answers[0].activeRevealId).toBe(firstRevealId + 1);
    expect(currentRound(state).questionPoints).toBe(40);
  });

  it('can retract the final reveal, reverse the round award, and award it again once', () => {
    let state = mainPlayGame();
    state = send(state, { type: 'reveal_answer', answerId: 'answer-1-a' });
    state = send(state, { type: 'reveal_answer', answerId: 'answer-1-b' });
    expect(state.teamScores).toEqual({ team_one: 60, team_two: 0 });

    const finalRevealId = currentRound(state).answers[1].activeRevealId;
    if (finalRevealId === null) throw new Error('Expected an active final reveal.');
    state = send(state, { type: 'retract_answer', answerId: 'answer-1-b', revealId: finalRevealId });
    expect(currentRound(state).phase).toBe('main_play');
    expect(currentRound(state).questionPoints).toBe(40);
    expect(currentRound(state).scoreAward).toBeNull();
    expect(state.teamScores).toEqual({ team_one: 0, team_two: 0 });

    state = send(state, { type: 'grant_play_attempt', team: 'team_one' });
    state = send(state, { type: 'reveal_answer', answerId: 'answer-1-b' });
    expect(currentRound(state).phase).toBe('completed');
    expect(state.teamScores).toEqual({ team_one: 60, team_two: 0 });
  });

  it('records a post-retraction error against the team that submitted the retracted answer', () => {
    let state = send(mainPlayGame('team_one'), { type: 'reveal_answer', answerId: 'answer-1-a' });
    const revealId = currentRound(state).answers[0].activeRevealId;
    if (revealId === null) throw new Error('Expected an active reveal.');
    state = send(state, { type: 'retract_answer', answerId: 'answer-1-a', revealId });
    state = send(state, { type: 'record_play_error', team: 'team_one' });

    expect(currentRound(state).mainPlayErrors).toBe(1);
    expect(state.events.at(-1)).toMatchObject({ type: 'play_error_recorded', team: 'team_one' });
  });

  it('retracts an ownership answer and lets the host choose a miss or a retry', () => {
    let state = send(ownershipGame('team_one'), {
      type: 'submit_ownership_answer',
      team: 'team_one',
      correct: true,
    });
    const resolutionId = currentRound(state).ownershipResolution?.id;
    if (resolutionId === undefined) throw new Error('Expected an ownership resolution.');
    state = send(state, { type: 'retract_ownership_answer', resolutionId });

    expect(currentRound(state).phase).toBe('ownership');
    expect(currentRound(state).mainPlayErrors).toBe(0);
    expectRejected(state, { type: 'submit_ownership_answer', team: 'team_one', correct: true }, 'ownership_decision_pending');
    state = send(state, { type: 'record_ownership_error' });
    expect(currentRound(state).ownershipTurnTeam).toBe('team_two');
    expect(currentRound(state).ownershipMisses).toBe(1);
    expect(currentRound(state).mainPlayErrors).toBe(0);

    let retryState = send(ownershipGame('team_two'), {
      type: 'submit_ownership_answer',
      team: 'team_two',
      correct: true,
    });
    const retryResolutionId = currentRound(retryState).ownershipResolution?.id;
    if (retryResolutionId === undefined) throw new Error('Expected an ownership resolution.');
    retryState = send(retryState, { type: 'retract_ownership_answer', resolutionId: retryResolutionId });
    retryState = send(retryState, { type: 'grant_ownership_retry' });
    expect(currentRound(retryState).ownershipTurnTeam).toBe('team_two');
    expect(currentRound(retryState).ownershipMisses).toBe(0);
  });

  it('rejects retracting a hidden answer or a stale repeated reveal without mutation', () => {
    const state = mainPlayGame();
    expectRejected(state, { type: 'retract_answer', answerId: 'answer-1-a', revealId: 1 }, 'answer_not_revealed');

    const revealed = send(state, { type: 'reveal_answer', answerId: 'answer-1-a' });
    const revealId = currentRound(revealed).answers[0].activeRevealId;
    if (revealId === null) throw new Error('Expected an active reveal.');
    const retracted = send(revealed, { type: 'retract_answer', answerId: 'answer-1-a', revealId });
    const retryGranted = send(retracted, { type: 'grant_play_attempt', team: 'team_one' });
    expectRejected(retryGranted, { type: 'retract_answer', answerId: 'answer-1-a', revealId }, 'answer_not_revealed');
  });

  it('rejects commands outside the active phase without changing the state or event log', () => {
    const state = newGame();
    expectRejected(state, { type: 'reveal_answer', answerId: 'answer-1-a' }, 'no_current_round');
    expectRejected(state, { type: 'resolve_steal', correct: true }, 'no_current_round');
  });

  it('completes three rounds and represents a tie without selecting a winner', () => {
    let state = newGame([0, 0]);
    state = send(state, { type: 'start_match' });
    for (let roundNumber = 1; roundNumber <= 3; roundNumber += 1) {
      const team: Team = roundNumber === 2 ? 'team_two' : 'team_one';
      state = send(state, { type: 'accept_buzz', team });
      state = send(state, { type: 'submit_ownership_answer', team, correct: true });
      state = send(state, { type: 'reveal_answer', answerId: `answer-${roundNumber}-a` });
      state = send(state, { type: 'reveal_answer', answerId: `answer-${roundNumber}-b` });
      if (roundNumber < 3) state = send(state, { type: 'advance_round' });
    }

    state = send(state, { type: 'advance_round' });
    expect(state.status).toBe('completed');
    expect(state.teamScores).toEqual({ team_one: 60, team_two: 60 });
    expect(state.outcome).toBe('tie');
  });

  it('pauses the match without losing the current phase and resumes explicitly', () => {
    const state = ownershipGame('team_two');
    const paused = send(state, { type: 'pause_for_host_disconnect' });

    expect(paused.status).toBe('paused_host_disconnected');
    expect(currentRound(paused).phase).toBe('ownership');
    expectRejected(paused, { type: 'submit_ownership_answer', team: 'team_two', correct: true }, 'match_is_paused');
    const resumed = send(paused, { type: 'resume_by_host' });
    expect(resumed.status).toBe('in_progress');
    expect(currentRound(resumed).ownershipTurnTeam).toBe('team_two');
  });
});
