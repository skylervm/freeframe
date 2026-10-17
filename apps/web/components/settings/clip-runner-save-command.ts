// One line, no &&. `set -e` stops before the write if the old file cannot be removed
// (an existing, wider-permission file would otherwise be overwritten in place), the
// file is created private (umask 077), and the folder may not exist yet.
export const SAVE_COMMAND =
  "(set -e; umask 077; mkdir -p ~/.config/freeframe; rm -f ~/.config/freeframe/clip-runner.token; pbpaste > ~/.config/freeframe/clip-runner.token)";
