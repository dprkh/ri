@web @listening @downloads
Feature: Chapter predownloads
  The listener can keep upcoming chapter audio ready for offline listening
  without downloading the whole library.

  Rule: Predownloads are automatic and bounded
    Scenario: Upcoming chapter predownloads start by default
      Given chapter 1 is ready to listen
      Then the download queue starts with the default window

    Scenario: Zero upcoming chapters keeps no chapter audio selected
      Given chapter 3 is ready to listen
      When the listener keeps no upcoming chapters offline
      Then no chapter audio is selected for offline listening

    Scenario: A large predownload window does not start every download at once
      Given chapter 1 is ready to listen
      When the listener chooses the largest predownload window under slow downloads
      Then the predownload work starts in a bounded queue
      And the chapter picker keeps a bounded visible window

    Scenario: Quota failure pauses predownloads
      Given download storage has no available space
      And chapter 1 is ready to listen
      Then the download queue reports insufficient storage

  Rule: Cached chapters stay playable offline
    Scenario: Next chapter opens from predownloaded assets while offline
      Given chapter 1 is ready to listen
      And chapter 2 is ready offline
      When the network becomes unavailable
      And the listener moves to the next chapter
      Then the browser shows chapter 2
      And chapter 2 can be played in supported browsers

    Scenario: Cached audio satisfies range playback
      Given chapter 1 is ready to listen
      And chapter 2 is ready offline
      When the network becomes unavailable
      Then cached audio for chapter 2 supports partial playback

    Scenario: Listener clears downloaded chapters
      Given chapter 1 is ready to listen
      And chapter 2 is ready offline
      When the listener clears chapter downloads
      Then downloaded chapter audio is removed

    Scenario: Predownload controls work across browser engines
      Then chapter predownloads are available in supported browser engines
