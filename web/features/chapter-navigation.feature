@web @listening
Feature: Chapter navigation
  The listener can open and move between available chapters with stable chapter
  URLs.

  Rule: Chapter URLs select the listening chapter
    Scenario: Root visit opens the first chapter
      Given the reader is ready to listen
      Then the browser shows chapter 1
      And the selected chapter is "Chapter 1"

    Scenario: Direct chapter URL opens the selected chapter
      Given chapter 3 is ready to listen
      Then the browser shows chapter 3
      And the selected chapter is "Chapter 3"
      And the chapter title is "Please go aside and scram"
      And the chapter opens without a manifest fetch

  Rule: Listener can choose another chapter
    Scenario: Listener sees chapter names before choosing
      Given chapter 1 is ready to listen
      When the listener reviews available chapters
      Then chapter 4 is offered as "Gu Yue Fang Yuan"

    Scenario: Listener narrows the chapter list
      Given chapter 1 is ready to listen
      When the listener searches available chapters for "Gu Yue"
      Then chapter 4 is offered as "Gu Yue Fang Yuan"
      And the chapter picker keeps a bounded visible window

    Scenario: Listener can browse every available chapter
      Given chapter 1 is ready to listen
      When the listener reviews available chapters
      Then the last available chapter can be reached
      And the chapter picker keeps a bounded visible window

    Scenario: Listener can search every available chapter
      Given chapter 1 is ready to listen
      When the listener searches for the last available chapter
      Then the last available chapter is offered
      And the chapter picker keeps a bounded visible window

    Scenario: Listener advances to the next chapter
      Given chapter 1 is ready to listen
      When the listener moves to the next chapter
      Then the browser shows chapter 2
      And the selected chapter is "Chapter 2"
      And chapter 2 can be played in supported browsers

    Scenario: Listener returns to the previous chapter
      Given chapter 2 is ready to listen
      When the listener moves to the previous chapter
      Then the browser shows chapter 1
      And the selected chapter is "Chapter 1"

    Scenario: Listener chooses a later chapter
      Given chapter 1 is ready to listen
      When the listener chooses chapter 4
      Then the browser shows chapter 4
      And the selected chapter is "Chapter 4"
      And the chapter title is "Gu Yue Fang Yuan"

  Rule: Chapter progress is independent
    Scenario: Saved progress follows the selected chapter
      Given the listener previously stopped at 30 seconds in chapter 1
      And the listener previously stopped at 45 seconds in chapter 2
      When the listener returns to chapter 2
      Then listening is positioned at "0:45"
