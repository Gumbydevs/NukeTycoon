CHANGELOG

2026-04-04
Enhanced version fetching and changelog loading with improved error handling and content type checks.
Improved changelog API to return structured JSON errors when the file is missing.
Made the version endpoint read from multiple package.json locations to ensure a version is available.
Added the application version display to the top bar and adjusted styles for better visibility.
Updated button variable names for clarity and improved HTML structure in the economy report.
Implemented the changelog modal in the UI and added the server endpoint to serve the changelog.
Added the connection indicator and app version display to the UI.
Improved building placement checks and enhanced ghost rendering when queuing builds.
Added an admin actions table and logged actions for balance saves and snapshot restores.
Enhanced the audit log display with snapshot restore notes and grouped change entries.
Added a purple button style for the balance tool history view and repositioned the audit section.
Updated administrative balance tool titles to match naming conventions.
Styled balance tool buttons and added a game settings toggle in the balance UI.
Added placeholder text for proximity bonus inputs and hid section bodies on initial load.
Added expandable game settings and grid sections with detailed proximity configuration options.
Added collapsible sections for snapshots, benchmarks, audit, grid, economy, production, and sabotage.
Enhanced the balance tool with snapshot management and control buttons.
Implemented snapshot management for server configuration.
Enhanced runtime configuration for economy and sabotage parameters.
Built the balance management UI and implemented server config audit functionality.
Implemented admin key management and audit logging for administrative access.
Adjusted silo limits and cooldowns to improve game balance.
Synchronized the Round HUD with the server-authoritative runLength setting.
Updated next day calculation to prefer per-run duration and ensure next_day_at is set correctly.
Fixed economy calculations to compute net income by subtracting total maintenance costs from gross income.
Promoted queued builds to active status when players have free construction slots.
Enhanced notification handling for building completions and chat messages.
Added logging for notification requests and responses to aid debugging.
Cleared queued builds on reset and placement to prevent ghost entries.
Normalized chat message keys for consistency between historical and live payloads.
Implemented UPSERT behavior for building placement to handle unique constraint conflicts.
Fixed database deletion ordering to delete child table data before parents to avoid foreign key errors.
Improved notification time color for better contrast in the UI.
Stringified notification payloads and set default values for last_seen while improving sabotage notification handling.
Persisted chat alerts across relog and backfilled missed messages.
Normalized notification insertion logic to match by email or player id.
Executed the SQL schema as a raw file to preserve dollar-quoted functions during migrations.
Ran the full schema as a single query during migration and moved notification trigger creation to the end.
Added email column to notifications and created the alltime_player_bests table.
Added triggers and updates to ensure notification email is set from player id when not provided.
Updated notification logic to fetch by player email rather than by player id.
Fetched notifications by player email in the run join handler.
Added debug logging for player notifications in the run join handler.
Logged received notifications from the server in the connectSocket function.
Preserved exact read state for notifications in the chat handler.
Updated socket event payloads to include both chatMessages and notifications.
Improved chat message handling so messages are consistently cleared and rendered from the server.
Streamlined chat message handling to use the persisted chatMessages variable directly.
Optimized chat message rendering by assigning persisted messages directly to state.
Stored chat messages in game state for consistent persistence.
Added cancel-queue functionality and a popup for player-owned queued buildings.
Added utility scripts for token counting and brace matching in gameLoop.js.
Refactored processRunEconomy by removing the processBuildQueue function and related error handling.
Implemented a sell and demolish popup for player-owned buildings.
Refactored building demolish and cancel queue event handling for better clarity.
Implemented server-side handling for building demolish and cancel queue actions.
Improved the help modal copy and visuals to be friendlier and clearer.
Refactored help content for clarity and better player guidance.
Enhanced player data handling to support avatar and photo updates.
Updated the deposit indicator icon to a flag emoji for clarity.
Fixed a ReferenceError in the profile modal and added avatar_photo in economy SQL and queries.
Implemented a Remember Me option for login credentials.
Added silent reconnect handling for a smoother experience on page load.
Enhanced landing page styles and added modal style overrides.
Fixed GROUP BY issues by including avatar fields in calculateScores queries.
Replaced emoji placeholders with profile photos across the UI and server queries.
Fixed profile photos being square instead of circular.
Added profile photo upload and a sound toggle in the action menu and enabled photos in chat and lobby views.
Fixed the prize pool hero display to use tokensPerUSD rate so top bar math matches the hero amount.
Removed leaderboard overflow bars and balanced the leaderboard columns while ensuring prize pool shows tokens and USD.
Implemented all time economy stats including ATH and ATL charts, records strip, Hall of Fame, and admin reset controls.
Fixed economy modal building list layout, pluralization, and token column headers.
Fixed header play buttons to link to GitHub Pages and added a clear play CTA to the header.
Cleaned up economy modal labels and units for clarity.
Added the economy tracker system with a web dashboard, in-game modal tabs, daily snapshots, and Chart.js charts.

2026-04-03
Fixed chat toggle animation to show on incoming messages and guarded the toggle while the panel is open.
Added a static GIF picker and smaller thumbnails and allowed a Giphy CDN proxy.
Moved chat to the bottom-left and moved help and legend to the bottom-right for clarity.
Fixed chat picker overflow and made GIFs proxy through the server to avoid 401 issues.
Implemented live chat with toggle, emoji picker, Tenor GIF search, and floating toasts when chat is closed.
Adjusted crater visuals to be driven by server fallout zone data with an authoritative radius.
Raised client side nuke limits to 999 for testing scenarios.
Set strike limit per day to 999 for testing purposes.
Added nuke crater visualization and fixed persistence of owned borders after nukes.
Ensured nukes also remove own buildings from game.buildings so maintenance floats stop correctly.
Added a 15 percent sabotage failure chance and improved attacker defender and spectator notifications.
Refined processor and plant proximity and road bonuses and updated all tooltips accordingly.
Excluded queued ghost buildings from maintenance and income floats.
Showed cost float at building cell on place to match wallet deductions.
Implemented ghost cells for queued buildings with dimmed icons and queue position badges.
Added modular build slots and queue limits to the game state.
Added a configurable build queue limit with notifications when the queue is full.
Rebalanced the economy by adjusting income multipliers and maintenance costs and setting buy-in to 20,000 tokens.
Made building floats absolute inside cells and improved size and animation.
Moved building floats to the server authoritative run:tick handler.
Added per-building income and maintenance floating labels on production ticks.
Replaced Workers En Route overlay with a zoom fade floating text presentation.
Emitted run building configuration to each socket on join so tooltip costs are accurate.
Adjusted the Workers En Route display timing and ensured consistent visibility.
Derived construction total milliseconds from server timestamps and fixed stuck progress rings.
Optimistically showed Workers En Route on cell click in online mode.
Added a Web Audio engine and hooked it into the Workers En Route display flow for better feedback.
Refined button positions and debounced actions menu toggles for reliability.
Updated actions menu accessibility and event models for better keyboard support.
Adjusted toolbar and legend button positioning for layout and accessibility improvements.
Reseeded maintenance costs to defaults and added economy diagnostic logging.
Enhanced admin panel raw response sections and improved table styling.
Synchronized displayed wallet with server authoritative state.
Added the option to disable bots in game settings.
Updated maintenance costs and added maintenance cost fields to building types.
Adjusted income calculation in productionTick and processRunEconomy to match server logic.
Improved wallet update handling with floating gain and loss indicators.
Made building costs read live from BUILDING_RULES for immediate admin changes.
Updated deposit generation to skip road cells in terrain logic.
Added database integration for building rules management and persisted configuration.
Implemented building configuration management in the admin panel and fixed bot interaction bugs.
Enhanced leaderboard display to synchronize live player data.
Added terrain and deposit handling to socket events for consistent map synchronization.
Simplified admin URL handling and added a redirect helper for admin access.
Implemented run length configuration in the admin panel and propagated it to socket events.
Removed an old admin HTML file from the repo to reduce confusion.
Added danger zone actions to the admin panel for maintenance and player management.
Added a dev-start script to boot the local server and frontend together.
Added nodemailer to the server and updated game loop and socket handlers for email OTP.
Updated leaderboard labels and adjusted sidebar position for better visibility.
Added a live players leaderboard sidebar with throttled rendering.
Implemented server time synchronization for building construction updates.
Scheduled construction progress and visual updates from the server side.
Enhanced building rendering with progress percentage displays and additional error handling.
Throttled DOM updates to improve performance when rendering many buildings.
Updated stylesheet and script version references for consistency.
Improved construction timing logic and animation handling for smoother visuals.
Improved building rendering and simulation loop management for better reliability.

2026-04-02
Enhanced construction UI by adding DOM timing data used to animate progress rings.
Improved building construction logic to track total time and update UI accordingly.
Corrected the project name from NUKWAR to NUKEWAR in various places and adjusted default run length to 3 days.
Added a help UI with a legend toggle and a help modal for player instructions.
Fixed construction timer guards to respect construction end timestamps rather than a boolean flag.
Made progress rings driven purely by wall clock construction end timestamps.
Updated building rendering to handle completed state and clear construction end times properly.
Improved construction progress ring filling logic using wall clock time.
Improved construction progress calculation and rendering for buildings.
Removed border color from fallout cells for a subtler visual effect.
Enhanced fallout animation and cell styling for improved visuals.
Improved construction timing and rendering logic across the codebase.
Enhanced game economy and player state management systems.
Added server scoring and prize pool management hooks to improve economy sync.
Implemented password based authentication with signup and login for testing.
Improved authentication acknowledgment handling in requests and verification flows.
Enhanced admin key input handling and API base detection logic.
Added a .nojekyll file to prevent GitHub Pages from processing the site.
Added an admin panel for server management with key based authentication and control actions.
Implemented AI bot functionality with a toggle and integrated it into game mechanics.
Added player avatar selection and default avatar handling during account setup.
Prevented transport close disconnects and game state resets after login.
Clarified token economics instructions in the prize pool UI.
Added username change functionality with validation and feedback.
Appended a version query to the game.js script to bust caches when updating.
Added error handling for missing DATABASE_URL during database initialization.
Improved database initialization error logging and updated the server listen address.
Fixed crashes when RESEND_API_KEY is missing by adding checks.
Added nixpacks configuration and an initial package-lock.json.
Added initial Railway configuration files for build and deployment.
Enhanced database initialization with auto retry and schema migration logic.
Split migration statements to avoid fatal errors on some servers.
Updated socket transports to include polling for compatibility with proxies.
Implemented auto-run schema migration on server startup to keep DB up to date.
Updated SERVER_URL for production deployment and cleaned up DEPLOY.md.
Updated branding references from Nuclear Tycoon to NUKWAR in HTML and email templates.
Implemented email based login with OTP verification.
Removed outdated Phase 3 notes from the README.
Enhanced prize distribution logic so leaderboard awards reflect the intended distribution.
Addressed mobile UI bugs and improved mobile usability.

2026-03-29
Improved portfolio display formatting to remove dollar signs and clarify values.
Simplified wallet display logic by removing market price drift effects.
Enhanced wallet synchronization and market price responsiveness.
Added smooth wallet display animation and optimized income feedback visuals.
Improved player ownership resolution and enemy building tooltip displays.
Improved notification messages for clarity and simplified wording.
Updated the lobby and buy in button copy and styles for clarity.
Enhanced action menu tooltip content and positioning for better usability.
Implemented ephemeral toast notifications for lightweight feedback.
Increased mobile UI responsiveness and improved time display formatting.
Added a secret shortcut to toggle developer tools visibility.
Refactored the actions menu for improved accessibility and mobile positioning.
Improved mobile menu touch support and z-index handling.
Added compact mobile stats and adjusted the prize pool display to be concise.
Enhanced prize pool formatting and added a tooltip for USD equivalent.
Implemented the actions menu for building selection and toolbar interactions.
Implemented uranium deposits with visual indicators and proximity bonuses for mining efficiency.
Added the silo building type and implemented nuclear strike mechanics and fallout effects.
Updated construction times for building types to improve game pacing.
Added configurable construction times and progress indicators for buildings.
Marked run length and event driven statuses and improved run end summaries.
Enhanced run end summary to include player stats and economy insights.

2026-03-28
Ensured enemy building placements avoid roads and unoccupied tiles are preferred.
Disallowed building placement on road tiles and improved tooltip messages for productivity hints.
Added visuals for horizontal roads and crossroad junctions.
Refactored building button UI to simplify the layout.
Enhanced UI icons and tooltip clarity for buildings and actions.
Added road branches and income bonuses for buildings adjacent to roads.
Initialized total buy in calculation and improved circulating supply and stored uranium formatting.
Refactored uranium handling to separate raw and refined values and updated UI accordingly.
Adjusted uranium production and consumption rates for better balance.
Refined numeric supply formatting for large numbers.
Increased max storage capacity and improved UI formatting for uranium values.
Fixed typos in lobby modal entry fee descriptions.
Added the lobby modal for buy in confirmation and prize pool display.
Implemented token economy features and prize pool distribution UI updates.
Added mobile menu behavior and responsive styles for better usability on small screens.
Added initial terrain generation and visuals for grid cells including grass dirt and roads.
Refactored grid and cell styles for improved responsiveness and updated the legend.
Increased padding and font sizes for readability in main styles.
Added the player profile modal and updated avatar styling.
Enhanced building icons with emoji and SVG fallback support.
Implemented client side password hashing for authentication flows.
Removed obsolete project structure content from the README and streamlined the document.
Added initial project scaffolding and core prototype files for the project.

Developer notes from Slack channels
The included prototype files are index.html main.css and game.js and they contain the playable prototype UI styling and developer notes.
Core gameplay uses a grid placement loop where players place Mines Processors Storage and Reactors and spend tokens to build or sabotage.
Clicking a build button and then a grid cell places a building and occupied cells prevent further placement.
Mines produce uranium Storage increases capacity and Reactors consume fuel to generate income on a continuous per second production tick.
A live market updates every tick using noise plus supply and demand drift and portfolio equals wallet plus stored uranium times market price.
Reactors generate power with penalties when enemy buildings are nearby and small jitter makes power feel dynamic.
Enemy buildings appear as AI placeholders and sabotage is a costly strategic option that can destroy enemy cells.
Top bar shows round tokens uranium stored power rank day time market income portfolio and build buttons with a legend.
A dev panel allows time acceleration advancement by hours or single step control for testing the simulation.
Default time mapping uses one real second per simulated minute with dev speed available for quick testing.
Tooltips show contextual help and cost and cell tooltips preview placement when in build mode.
Enhanced building icons and updated CSS readability and added a player profile modal framework.
Terrain generation and deposit flags were added and the token economy and prize pool UI were implemented with buy in lobby modal.
Run length can be configured in game.runLength and runs end automatically when game.time.day exceeds runLength.
Construction times are configurable and buildings now show a visual clock timer while building.
Silo and nuclear strike mechanics were added along with fallout effects and expanded sabotage attack options.
Deposits provide proximity bonuses for mining and the UI was cleaned up with an actions menu for better desktop use.
Prize pool clarity added fiat equivalent display and tokensPerUSD conversion and lobby summary updates.
Mobile fixes were applied for menus and stats and keyboard shortcuts were added for toggles and dev tools.
Profile photo support including animated GIFs was added and photos now show in chat and lobbies.
Back end database work was added for persistence build rules and admin controls with auto migration.
Email OTP was integrated for login testing but password auth is used until production email is configured.
Construction timing bugs were fixed by enforcing server side authority on build completion and adding progress percentage UI.
Throttled DOM updates fixed rendering bottlenecks and improved overall performance.
Live leaderboard and notification drawer were implemented along with better offline notification handling.
Admin tools for run control player management balance wipes and building rule persistence were added.
Web Audio based sounds were added for satisfying feedback tuned to game events including nuke events.
Multiple economy balancing passes changed income multipliers maintenance costs build limits and buy in amounts.
The repository includes deployment config for Railway nixpacks and a dev-start script to spin up local server and frontend.

This changelog contains commit derived entries and developer notes grouped by date.
If you want every commit expanded into longer human descriptions or prefer release grouping say so and I will reformat.
