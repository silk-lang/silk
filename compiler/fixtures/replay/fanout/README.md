# Replay fanout ledger

Each `.txt` file here raises (or lowers) the limit on a replay fanout step in
`../budgets.json`: the units a trivia edit to the budgeted module marks outdated. A change
that adds code reading that module adds one file of its own, so two branches never edit the
same line:

```
# silk.compress.zip reads Bytes in its member reader and inflater.
stdlib +5
```

Each line is `<name> <+n|-n>`, where the name is a key of the top-level `fanout` object
(`stdlib` or `compiler`), and `#` starts a comment. `.github/scripts/check-replay-budgets.mjs`
adds every line to that base, and prints the line to add when a fanout step goes over. To fold
the ledger, add each name's sum to its base and delete the files, in a change of its own.
