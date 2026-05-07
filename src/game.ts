type ListGt2<T> = [T, T, ...T[]];
type NonNull<T> = Exclude<T, null>;
function hasKey<T extends object>(
  obj: T,
  key: PropertyKey
): key is keyof T {
  return key in obj;
}
export function assign<T extends object>(
  dest: T,
  src: T
) {
  for (let key in dest) {
    dest[key] = src[key];
  }
}

type State =
  | SharedS
  | [/* left */ SingleS, /* right */ SingleS];

// type StateChange = (s: S) => S;

export type S = {
  lastIndividual: [SingleS | null, SingleS | null],
  lastShared: SharedS | null,
  state: State,
  q:
  | {
    q: string, // question you need to Yes or No
    left: boolean, // question is to be answered by left
    as: ListGt2<[string, S]>, // answers: state transition map
  }
  | null,
};

const clone = {
  SingleS(s: SingleS): SingleS {
    if (typeof s === 'string')
      return s;
    else
      return { custom: s.custom };
  },

  SharedS(s: SharedS): SharedS {
    if (typeof s === 'string')
      return s;
    else
      return { custom: s.custom };
  },

  S(s: S): S {
    return {
      lastIndividual: [
        s.lastIndividual[0] ? clone.SingleS(s.lastIndividual[0]) : null,
        s.lastIndividual[1] ? clone.SingleS(s.lastIndividual[1]) : null,
      ],

      lastShared: s.lastShared ? clone.SharedS(s.lastShared) : null,

      state: Array.isArray(s.state)
        ? [clone.SingleS(s.state[0]), clone.SingleS(s.state[1])]
        : clone.SharedS(s.state),

      q: s.q
        ? {
          q: s.q.q,
          left: s.q.left,
          as: s.q.as.map(([answer, nextState]) =>
            [answer, clone.S(nextState)] as [string, S]
          ) as ListGt2<[string, S]>,
        }
        : null
    }
  }
};


export const INITIAL_STATE: S = {
  lastIndividual: [null, null],
  lastShared: null,
  state: ['idle', 'idle'],
  q: null,
};

export function answer(s: S & { q: NonNull<S['q']> }, answer: number): S | string {
  const transition = s.q.as[answer];

  if (transition === undefined) {
    return "unknown answer";
  }

  if (transition[1] === undefined) {
    return s;
  }

  return transition[1];
}

export type SingleS =
  | 'idle'
  | 'blushing'
  | 'licking'
  | 'meowing' // one-shot
  | 'crying'
  | 'eating'
  | 'eeping'
  | { custom: string }
  // nsfw
  | 'self-procreating';

export type SharedS =
  | 'eeping'
  | 'snuggling'
  | 'hugging'
  | 'eating'
  | { custom: string }
  // nsfw
  | 'procreating';

// message received from any of the two participants in a date
export type Action =
  | SingleS
  | { shared: SharedS } // all requests
  | { response: number };

function id(s: S): S {
  return clone.S(s);
}

function replaceSingle(
  newSingle: SingleS,
  // `newSingle` becomes left's new state if `left` is true
  left: boolean,
  { state, lastIndividual, lastShared: prevLastShared }: S
): S {
  const lastShared = Array.isArray(state)
    ? (prevLastShared ? clone.SharedS(prevLastShared) : null)
    : clone.SharedS(state);

  const newLeftState = left
    ? newSingle
    : Array.isArray(state)
    	? state[0]
    	: lastIndividual[0]
	      ? lastIndividual[0]
	      : 'idle';

  const newRightState = !left
    ? newSingle
    : Array.isArray(state)
    	? state[1]
    	: lastIndividual[1]
	      ? lastIndividual[1]
	      : 'idle';

  lastIndividual = Array.isArray(state)
    ? state
    : lastIndividual;

  return {
    lastIndividual,
    lastShared,
    state: [newLeftState, newRightState],
    q: null,
  }
}

function replaceShared(
  newShared: SharedS, { state, lastIndividual, lastShared: prevLastShared }: S
): S {
  const lastShared = Array.isArray(state)
    ? prevLastShared
    : state;

  lastIndividual = Array.isArray(state)
    ? state
    : lastIndividual;

  lastIndividual = Array.isArray(state)
    ? state
    : lastIndividual;

  return {
    lastIndividual,
    lastShared,
    state: newShared,
    q: null,
  }
}

type ImmediateSingleActions = Exclude<Action, NotImmediateSingleActions>;

const immediateSingleActionSet: Record<string & ImmediateSingleActions, boolean> = {
  eeping: true,
  eating: true,
  idle: true,
  blushing: true,
  meowing: true,
  crying: true,
};

export const sharedActionSet: Record<string & SharedS, boolean> = {
  eeping: true,
  snuggling: true,
  hugging: true,
  eating: true,
  // nsfw
  procreating: true,
};

type NotImmediateSingleActions = 'licking' | 'self-procreating';

const notImmediateSingleActionQuestions: Record<
  NotImmediateSingleActions,
  // `left` is true if left made the action request
  (s: S, left: boolean) => NonNull<S['q']>
> = {
  licking: (s, left) => ({
    q: "may i lick uuu~? ☞~☜",
    left: !left, // question has to be answered by right
    as: [
      ["noooo not right now ! ( ˶•̀ㅁ•́) !!", id(s)],
      ["yayy lickies (˶˃𐃷˂˶)", replaceSingle('licking', left, s)],
    ],
  } as NonNull<S['q']>),

  'self-procreating': (s, left) => ({
    q: "would u mind if i make *sillies* next to you? (⸝⸝๑  ̫ ๑⸝⸝⸝)",
    left: !left, // question has to be answered by right
    as: [
      ["yess plss not right now if u dont mind! (♡ˊ͈ ꒳ ˋ͈)", id(s)],
      ["NOPE (⸝⸝⸝-﹏-⸝⸝⸝) *poggies* ♡(˃͈ ˂͈ )", replaceSingle('self-procreating', left, s)],
    ],
  } as NonNull<S['q']>),
};

const sharedActionQuestions: Record<
  Exclude<SharedS, { custom: string }>,
  (s: S, left: boolean) => NonNull<S['q']>
> = {
  'eeping': (s, left) => ({
    q: "",
    left,
    as: [
      ["", id(s)],
      ["", replaceShared('eeping', s)],
    ],
  }),
  'snuggling': (s, left) => ({
    q: "",
    left,
    as: [
      ["", id(s)],
      ["", replaceShared('snuggling', s)],
    ],
  }),
  'hugging': (s, left) => ({
    q: "",
    left,
    as: [
      ["", id(s)],
      ["", replaceShared('hugging', s)],
    ],
  }),
  'eating': (s, left) => ({
    q: "",
    left,
    as: [
      ["", id(s)],
      ["", replaceShared('eating', s)],
    ],
  }),
  'procreating': (s, left) => ({
    q: "",
    left,
    as: [
      ["", id(s)],
      ["", replaceShared('procreating', s)],
    ],
  }),
};

function stringIsImmediateSingleAction(a: string): a is Exclude<ImmediateSingleActions, object> {
  return a in immediateSingleActionSet;
}

function stringIsSharedAction(a: string): a is Exclude<SharedS, object> {
  return a in sharedActionSet;
}

// type NonSingleSingles = keyof typeof notImmediateSingleActions;

export function modify(s: S, a: Action, left: boolean): string | null {
  if (s.q) {

    if (typeof a === 'string') {
      return "answer question first";
    }

    if ('response' in a) {
      // question is to be answered by left but right is answering, or vice versa
      if (s.q.left && !left || !s.q.left && left) {
        return "no question to respond to";
      }

      const result = answer({ ...s, q: s.q }, a.response);
      if (typeof result === 'string') {
        return result;
      }
      assign(s, result);
      return null;
    }

    else if (s.q.left && !left || !s.q.left && left) {
      return "let them answer question first";
    }

    else {
      return "answer question first";
    }

  } else {

    if (typeof a === 'string') {
      if (hasKey(notImmediateSingleActionQuestions, a)) {
        s.q = notImmediateSingleActionQuestions[a](
          s,
          left
        );
        return null;
      } else if (stringIsImmediateSingleAction(a)) {
        assign(s, replaceSingle(a, left, s));
        return null;
      }
      return "unexpected msg";
    }

    else if ('custom' in a) {
      assign(s, replaceSingle(a, left, s));
      return null;
    }

    else if ('shared' in a) {
      if (typeof a.shared === 'string') {
        if (stringIsSharedAction(a.shared)) {
          s.q = sharedActionQuestions[a.shared](
            s,
            !left // if left asked, question has to be answered by right
          );
          return null;
        }
        return "unexpected msg";
      } else {
        s.q = {
          q: `Can we ${a.shared.custom} ?`,
          left: !left,
          as: [
            ["no", id(s)],
            ["yes", replaceShared(a.shared, s)],
          ],
        };
      }
      return null;
    }

    else if ('response' in a) {
      return "no question to respond to";
    }

    return "unexpected msg";
  }
}

