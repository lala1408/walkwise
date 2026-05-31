export const OPEN_DATA_USER_AGENT =
  process.env.OPEN_DATA_USER_AGENT ?? "walkwise/0.1 (https://github.com/lala1408/walkwise)";

export const OPEN_DATA_HEADERS = {
  "User-Agent": OPEN_DATA_USER_AGENT
};
