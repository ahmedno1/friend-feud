export const TEAMS = ['team_one', 'team_two'] as const;

export type Team = (typeof TEAMS)[number];
export type RoundNumber = 1 | 2 | 3;
export type MatchStatus = 'setup' | 'in_progress' | 'paused_host_disconnected' | 'completed';
export type RoundPhase =
  | 'pending'
  | 'toss'
  | 'ownership'
  | 'main_play'
  | 'steal'
  | 'completed';
export type MatchOutcome = Team | 'tie' | null;

export interface AnswerDefinition {
  readonly id: string;
  readonly text: string;
  readonly points: number;
}

export interface RoundDefinition {
  readonly questionId: string;
  readonly questionText: string;
  readonly answers: readonly AnswerDefinition[];
}

export interface MatchDefinition {
  readonly id: string;
  readonly rounds: readonly [RoundDefinition, RoundDefinition, RoundDefinition];
}

export interface RoundAnswer extends AnswerDefinition {
  readonly revealed: boolean;
  readonly activeRevealId: number | null;
  readonly revealedByTeam: Team | null;
}

export interface OwnershipResolution {
  readonly id: number;
  readonly team: Team;
  readonly retracted: boolean;
}

export interface StealState {
  readonly status: 'unavailable' | 'available' | 'used';
  readonly team: Team | null;
  readonly result: 'success' | 'failed' | null;
}

export interface ScoreAward {
  readonly team: Team;
  readonly points: number;
  readonly reason: 'all_answers_revealed' | 'steal_success' | 'steal_failed';
}

export interface RoundState {
  readonly number: RoundNumber;
  readonly phase: RoundPhase;
  readonly questionId: string;
  readonly questionText: string;
  readonly answers: readonly RoundAnswer[];
  readonly firstBuzzTeam: Team | null;
  readonly ownershipTurnTeam: Team | null;
  readonly ownerTeam: Team | null;
  readonly answeringTeam: Team | null;
  readonly ownershipMisses: number;
  readonly pendingOwnershipDecisionTeam: Team | null;
  readonly ownershipResolution: OwnershipResolution | null;
  readonly mainPlayErrors: number;
  readonly pendingRetractedAnswerTeam: Team | null;
  readonly steal: StealState;
  readonly questionPoints: number;
  readonly revealSequence: number;
  readonly scoreAward: ScoreAward | null;
}

export interface GameEvent {
  readonly sequence: number;
  readonly type:
    | 'match_started'
    | 'buzz_accepted'
    | 'ownership_answered'
    | 'ownership_turn_transferred'
    | 'ownership_answer_retracted'
    | 'ownership_error_recorded'
    | 'ownership_retry_granted'
    | 'answer_revealed'
    | 'answer_retracted'
    | 'play_attempt_granted'
    | 'play_error_recorded'
    | 'steal_opened'
    | 'steal_resolved'
    | 'round_completed'
    | 'round_advanced'
    | 'match_paused'
    | 'match_resumed'
    | 'match_completed';
  readonly roundNumber?: RoundNumber;
  readonly team?: Team;
  readonly answerId?: string;
  readonly revealId?: number;
  readonly correct?: boolean;
  readonly points?: number;
  readonly reason?: ScoreAward['reason'];
}

export interface GameState {
  readonly id: string;
  readonly status: MatchStatus;
  readonly rounds: readonly [RoundState, RoundState, RoundState];
  readonly currentRoundNumber: RoundNumber | null;
  readonly teamScores: Readonly<Record<Team, number>>;
  readonly outcome: MatchOutcome;
  readonly revision: number;
  readonly nextEventSequence: number;
  readonly events: readonly GameEvent[];
}

export type GameCommand =
  | { readonly type: 'start_match' }
  | { readonly type: 'accept_buzz'; readonly team: Team }
  | { readonly type: 'submit_ownership_answer'; readonly team: Team; readonly correct: boolean }
  | { readonly type: 'transfer_ownership_turn' }
  | { readonly type: 'retract_ownership_answer'; readonly resolutionId: number }
  | { readonly type: 'record_ownership_error' }
  | { readonly type: 'grant_ownership_retry' }
  | { readonly type: 'reveal_answer'; readonly answerId: string }
  | { readonly type: 'retract_answer'; readonly answerId: string; readonly revealId: number }
  | { readonly type: 'grant_play_attempt'; readonly team: Team }
  | { readonly type: 'record_play_error'; readonly team: Team }
  | { readonly type: 'resolve_steal'; readonly correct: boolean }
  | { readonly type: 'advance_round' }
  | { readonly type: 'pause_for_host_disconnect' }
  | { readonly type: 'resume_by_host' };

export type GameErrorCode =
  | 'invalid_match_definition'
  | 'match_not_in_setup'
  | 'match_not_in_progress'
  | 'match_is_paused'
  | 'match_not_paused'
  | 'no_current_round'
  | 'invalid_round_phase'
  | 'wrong_team'
  | 'buzz_already_accepted'
  | 'ownership_decision_pending'
  | 'no_retractable_ownership_answer'
  | 'answer_not_found'
  | 'answer_already_revealed'
  | 'answer_not_revealed'
  | 'stale_reveal'
  | 'play_retraction_pending'
  | 'no_play_retraction_pending'
  | 'invalid_steal'
  | 'unsafe_score_calculation'
  | 'round_not_complete'
  | 'round_already_awarded';

export type CommandResult =
  | { readonly ok: true; readonly state: GameState }
  | {
      readonly ok: false;
      readonly code: GameErrorCode;
      readonly message: string;
      readonly state: GameState;
    };

export function opposingTeam(team: Team): Team {
  return team === 'team_one' ? 'team_two' : 'team_one';
}
