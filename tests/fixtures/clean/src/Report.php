<?php

declare(strict_types=1);

namespace CleanFixture;

final class Report
{
    /**
     * Renders the report as CSV.
     */
    public function generate(): string
    {
        return implode("\n", $this->rows);
    }
}
