# CN upstream map release

The pinned upstream base is `84e14d6898994bddcdd190d579a4b78dc3b69320`.
The CN components are `cluster-render` 0.5.9 and `waze-on-cluster` 0.9.14.
The renderer contains the upstream map rendering and alert display changes.
The map service declares CN deploy 0.8.19 for recovery deactivation and safe-mode
unit support. Its recovery/boot units remain available in safe mode.

The Waze application remains 0.6.7. Chinese application packages, the domestic
catalog policy and the Chinese phone log interface retain their identities.
Reviewed upstream releases publish the same payloads to CN Beta and Stable.
Source and native-toolchain tests are distinct from vehicle validation; runtime
validation is pending unless supported by an actual report for the release.
