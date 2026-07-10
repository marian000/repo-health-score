# Clean Fixture

A small billing library. This repository is the healthy control: no secrets, no
vulnerable dependencies, no copyleft in an MIT project, a docblock above every
public function, and no file that only one person has ever touched.

## Installation

```
npm install clean-fixture
```

## Usage

```php
$invoice = new CleanFixture\Invoice();
echo $invoice->total();
```
