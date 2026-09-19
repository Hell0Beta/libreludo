import type { ReactNode } from 'react';
import { BoardModeContext, type TBoardActions } from './boardMode';

/**
 * Hand a subtree someone else's rules.
 *
 * Takes a non-nullable `TBoardActions`, so there is no way to write a provider that means "no
 * provider" — the null in the context type is reserved for *absence*, which is how a local board is
 * expressed, and a caller should not be able to reach it by passing a value in.
 */
export default function BoardModeProvider({
  actions,
  children,
}: {
  actions: TBoardActions;
  children: ReactNode;
}) {
  return <BoardModeContext.Provider value={actions}>{children}</BoardModeContext.Provider>;
}
