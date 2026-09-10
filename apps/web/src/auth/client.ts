import { createAuthClient } from "better-auth/react";

// Same-origin client: never import server env validation or credentials here.
export const { signIn, signUp, signOut, useSession } = createAuthClient();
