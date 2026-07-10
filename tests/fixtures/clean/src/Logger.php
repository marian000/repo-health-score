<?php

declare(strict_types=1);

namespace CleanFixture;

final class Logger
{
    /**
     * Appends one line to the configured log sink.
     */
    public function write(string $message): void
    {
        $this->sink->append($message);
    }
}
