# Vendored build SDK

This deployment-local copy mirrors `sdk/index.js`. Azure Developer CLI packages
each service from its project directory, so a sibling `file:../sdk` dependency
is not available to the Function App's remote npm install.

Keep `index.js` synchronized with the root SDK when its runtime exports change.
