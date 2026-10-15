import { applyGameCommand, createGameState } from './game-domain';
import {
  GAME_STATE_SCHEMA_VERSION,
  GameStateSerializationError,
  hydrateGameState,
  serializeGameState,
} from './game-state-serialization';
import { GameCommand, GameEvent, GameState, MatchDefinition, RoundDefinition, RoundState, Team } from './types';

type AnswerPoints = readonly [number, number];
type MatchRoundPoints = readonly [AnswerPoints, AnswerPoints, AnswerPoints];

function roundDefinition(number: number, points: AnswerPoints = [40, 20]): RoundDefinition {
  return {
    questionId: `question-${number}`,
    questionText: `Question ${number}`,
    answers: [
      { id: `answer-${number}-a`, text: `Answer ${number} A`, points: points[0] },
      { id: `answer-${number}-b`, text: `Answer ${number} B`, points: points[1] },
    ],
  };
}

function newGame(points: MatchRoundPoints = [[40, 20], [40, 20], [40, 20]]): GameState {
  const definition: MatchDefinition = {
    id: 'match-serialization-test',
    rounds: [roundDefinition(1, points[0]), roundDefinition(2, points[1]), roundDefinition(3, points[2])],
  };
  return createGameState(definition);
}

function send(state: GameState, command: GameCommand): GameState {
  const result = applyGameCommand(state, command);
  if (!result.ok) throw new Error(`Unexpected game command rejection: ${result.code}`);
  return result.state;
}

function currentRound(state: GameState): RoundState {
  if (state.currentRoundNumber === null) throw new Error('Expected a current round.');
  return state.rounds[state.currentRoundNumber - 1];
}

function startOwnership(team: Team = 'team_one'): GameState {
  let state = send(newGame(), { type: 'start_match' });
  state = send(state, { type: 'accept_buzz', team });
  return state;
}

function startMainPlay(team: Team = 'team_one'): GameState {
  return send(startOwnership(team), { type: 'submit_ownership_answer', team, correct: true });
}

function startSteal(): GameState {
  let state = startMainPlay();
  for (let error = 0; error < 3; error += 1) {
    state = send(state, { type: 'record_play_error', team: 'team_one' });
  }
  return state;
}

function completeTie(): GameState {
  const zeroPoints: MatchRoundPoints = [[0, 0], [0, 0], [0, 0]];
  let state = send(newGame(zeroPoints), { type: 'start_match' });
  for (let roundNumber = 1; roundNumber <= 3; roundNumber += 1) {
    state = send(state, { type: 'accept_buzz', team: 'team_one' });
    state = send(state, { type: 'submit_ownership_answer', team: 'team_one', correct: true });
    state = send(state, { type: 'reveal_answer', answerId: `answer-${roundNumber}-a` });
    state = send(state, { type: 'reveal_answer', answerId: `answer-${roundNumber}-b` });
    if (roundNumber < 3) state = send(state, { type: 'advance_round' });
  }
  return send(state, { type: 'advance_round' });
}

function parseEnvelope(serialized: string): { stateSchemaVersion: number; state: Record<string, unknown> } {
  return JSON.parse(serialized) as { stateSchemaVersion: number; state: Record<string, unknown> };
}

describe('game state serialization', () => {
  it('round-trips the complete initial state with deep equality and an explicit schema version', () => {
    const original = newGame();
    const serialized = serializeGameState(original);
    const envelope = parseEnvelope(serialized);

    expect(envelope.stateSchemaVersion).toBe(GAME_STATE_SCHEMA_VERSION);
    expect(envelope.state).not.toHaveProperty('teamScores');
    expect((envelope.state.rounds as Array<Record<string, unknown>>)[0]).not.toHaveProperty('questionPoints');
    expect(hydrateGameState(serialized)).toEqual(original);
  });

  it.each([
    ['ownership selection', () => startOwnership('team_two')],
    ['ownership miss and alternating turn', () => send(startOwnership(), {
      type: 'submit_ownership_answer', team: 'team_one', correct: false,
    })],
    ['retracted ownership answer awaiting host decision', () => {
      let state = send(startOwnership(), {
        type: 'submit_ownership_answer', team: 'team_one', correct: true,
      });
      const resolutionId = currentRound(state).ownershipResolution?.id;
      if (resolutionId === undefined) throw new Error('Expected an ownership resolution.');
      return send(state, { type: 'retract_ownership_answer', resolutionId });
    }],
    ['retracted ownership answer resolved as an error', () => {
      let state = send(startOwnership(), {
        type: 'submit_ownership_answer', team: 'team_one', correct: true,
      });
      const resolutionId = currentRound(state).ownershipResolution?.id;
      if (resolutionId === undefined) throw new Error('Expected an ownership resolution.');
      state = send(state, { type: 'retract_ownership_answer', resolutionId });
      return send(state, { type: 'record_ownership_error' });
    }],
    ['main play', () => startMainPlay()],
    ['available steal', () => startSteal()],
    ['host paused during steal', () => send(startSteal(), { type: 'pause_for_host_disconnect' })],
    ['failed steal award', () => send(startSteal(), { type: 'resolve_steal', correct: false })],
    ['successful steal award', () => send(startSteal(), { type: 'resolve_steal', correct: true })],
    ['pending answer undo', () => {
      let state = send(startMainPlay(), { type: 'reveal_answer', answerId: 'answer-1-a' });
      const revealId = currentRound(state).answers[0].activeRevealId;
      if (revealId === null) throw new Error('Expected a reveal id.');
      return send(state, { type: 'retract_answer', answerId: 'answer-1-a', revealId });
    }],
    ['reveal, undo, and re-reveal history', () => {
      let state = send(startMainPlay(), { type: 'reveal_answer', answerId: 'answer-1-a' });
      const revealId = currentRound(state).answers[0].activeRevealId;
      if (revealId === null) throw new Error('Expected a reveal id.');
      state = send(state, { type: 'retract_answer', answerId: 'answer-1-a', revealId });
      state = send(state, { type: 'grant_play_attempt', team: 'team_one' });
      return send(state, { type: 'reveal_answer', answerId: 'answer-1-a' });
    }],
    ['final reveal undo after the round award', () => {
      let state = send(startMainPlay(), { type: 'reveal_answer', answerId: 'answer-1-a' });
      state = send(state, { type: 'reveal_answer', answerId: 'answer-1-b' });
      const revealId = currentRound(state).answers[1].activeRevealId;
      if (revealId === null) throw new Error('Expected a final reveal id.');
      return send(state, { type: 'retract_answer', answerId: 'answer-1-b', revealId });
    }],
    ['paused host disconnect', () => send(startOwnership('team_two'), { type: 'pause_for_host_disconnect' })],
    ['resumed host disconnect', () => send(
      send(startOwnership('team_two'), { type: 'pause_for_host_disconnect' }),
      { type: 'resume_by_host' },
    )],
    ['completed tie with optional undefined event property', () => completeTie()],
  ])('round-trips %s state without losing fields', (_name, createState) => {
    const original = createState();
    const restored = hydrateGameState(serializeGameState(original));
    expect(restored).toEqual(original);
  });

  it('preserves event sequence independently from command revision for multi-event commands', () => {
    let state = send(startMainPlay(), { type: 'reveal_answer', answerId: 'answer-1-a' });
    const revisionBeforeFinalReveal = state.revision;
    state = send(state, { type: 'reveal_answer', answerId: 'answer-1-b' });

    expect(state.events.slice(-2).map((event) => event.type)).toEqual(['answer_revealed', 'round_completed']);
    expect(state.revision).toBe(revisionBeforeFinalReveal + 1);
    expect(state.events.at(-1)?.sequence).toBe(state.nextEventSequence - 1);
    expect(hydrateGameState(serializeGameState(state))).toEqual(state);
  });

  it('preserves an own optional event property whose value is undefined', () => {
    const state = completeTie();
    const finalEvent = state.events.at(-1);
    expect(finalEvent?.type).toBe('match_completed');
    expect(finalEvent && Object.prototype.hasOwnProperty.call(finalEvent, 'team')).toBe(true);
    expect(finalEvent?.team).toBeUndefined();

    const restoredEvent = hydrateGameState(serializeGameState(state)).events.at(-1);
    expect(restoredEvent && Object.prototype.hasOwnProperty.call(restoredEvent, 'team')).toBe(true);
    expect(restoredEvent?.team).toBeUndefined();
  });

  it('does not change the source state during serialization', () => {
    const state = send(startMainPlay(), { type: 'reveal_answer', answerId: 'answer-1-a' });
    const before = structuredClone(state);

    serializeGameState(state);

    expect(state).toEqual(before);
  });

  it('returns independently allocated nested objects for separate hydrations', () => {
    const serialized = serializeGameState(startMainPlay());
    const first = hydrateGameState(serialized);
    const second = hydrateGameState(serialized);

    (first.rounds[0].answers[0] as { text: string }).text = 'changed in first result';
    (first.events as GameEvent[]).push({ sequence: first.nextEventSequence, type: 'match_paused' });

    expect(second.rounds[0].answers[0].text).toBe('Answer 1 A');
    expect(second.events).toHaveLength(3);
  });

  it('rejects an unknown schema version', () => {
    const envelope = parseEnvelope(serializeGameState(newGame()));
    envelope.stateSchemaVersion = GAME_STATE_SCHEMA_VERSION + 1;

    expect(() => hydrateGameState(JSON.stringify(envelope))).toThrow(/Unsupported game state schema version/);
  });

  it('rejects missing state fields and inconsistent phase data instead of defaulting values', () => {
    const missingField = parseEnvelope(serializeGameState(newGame()));
    delete missingField.state.events;
    expect(() => hydrateGameState(JSON.stringify(missingField))).toThrow(/events.*is required/);

    const invalidPhase = parseEnvelope(serializeGameState(startMainPlay()));
    const rounds = invalidPhase.state.rounds as Array<Record<string, unknown>>;
    rounds[0].mainPlayErrors = 3;
    expect(() => hydrateGameState(JSON.stringify(invalidPhase))).toThrow(/inconsistent with main play/);
  });

  it('rejects malformed JSON with a clear serialization error', () => {
    expect(() => hydrateGameState('{not-json')).toThrow(GameStateSerializationError);
  });

  it('round-trips the maximum safe question total without numeric loss', () => {
    const maxPoints: MatchRoundPoints = [
      [Number.MAX_SAFE_INTEGER - 1, 1],
      [0, 0],
      [0, 0],
    ];
    let state = send(newGame(maxPoints), { type: 'start_match' });
    state = send(state, { type: 'accept_buzz', team: 'team_one' });
    state = send(state, { type: 'submit_ownership_answer', team: 'team_one', correct: true });
    state = send(state, { type: 'reveal_answer', answerId: 'answer-1-a' });
    state = send(state, { type: 'reveal_answer', answerId: 'answer-1-b' });

    const restored = hydrateGameState(serializeGameState(state));
    expect(currentRound(restored).questionPoints).toBe(Number.MAX_SAFE_INTEGER);
    expect(restored.teamScores.team_one).toBe(Number.MAX_SAFE_INTEGER);
    expect(restored).toEqual(state);
  });

  it('rejects unsafe altered answer points instead of hydrating an invalid snapshot', () => {
    const envelope = parseEnvelope(serializeGameState(newGame()));
    const rounds = envelope.state.rounds as Array<{ answers: Array<Record<string, unknown>> }>;
    rounds[0].answers[0].points = Number.MAX_SAFE_INTEGER;

    expect(() => hydrateGameState(JSON.stringify(envelope))).toThrow(/sum exceeds Number.MAX_SAFE_INTEGER/);
  });
});
